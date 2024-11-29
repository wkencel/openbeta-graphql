import { MongoDataSource } from 'apollo-datasource-mongodb'
import { Filter, Document } from 'mongodb'
import muuid from 'uuid-mongodb'
import bboxPolygon from '@turf/bbox-polygon'

import { getAreaModel, getMediaObjectModel } from '../db/index.js'
import { AreaType, IAreaProps, ShadowArea } from '../db/AreaTypes'
import {
  AreaFilterParams,
  BBoxType,
  ComparisonFilterParams,
  CragsNear,
  GQLFilter,
  LeafStatusParams,
  PathTokenParams,
  StatisticsType
} from '../types'
import { getClimbModel } from '../db/ClimbSchema.js'
import { ClimbGQLQueryType } from '../db/ClimbTypes.js'
import { logger } from '../logger.js'

export default class AreaDataSource extends MongoDataSource<AreaType> {
  areaModel = getAreaModel()
  climbModel = getClimbModel()
  mediaObjectModal = getMediaObjectModel()

  async findAreasByFilter (filters?: GQLFilter): Promise<any> {
    let mongoFilter: any = {}
    if (filters !== undefined) {
      mongoFilter = Object.entries(filters).reduce<Filter<AreaType>>((acc, [key, filter]): Filter<AreaType> => {
        switch (key) {
          case 'area_name': {
            const areaFilter = (filter as AreaFilterParams)
            const param = areaFilter.exactMatch !== true ? new RegExp(areaFilter.match, 'ig') : areaFilter.match
            acc.area_name = param
            break
          }
          case 'leaf_status': {
            const leafFilter = filter as LeafStatusParams
            acc['metadata.leaf'] = leafFilter.isLeaf
            break
          }

          // Add score conversion to climbs
          case 'path_tokens': {
            const pathFilter = filter as PathTokenParams
            // In the event that we need an exact match we will filter on { name }[] for some path
            // that matches exactly.
            if (pathFilter.exactMatch === true) {
              acc['embeddedRelations.ancestors'] = pathFilter.tokens.map(name => ({ name }))
            } else {
              const filter: Record<string, any> = {}
              filter.$all = pathFilter.tokens.map(name => ({ name }))

              if (pathFilter.size !== undefined) {
                filter.$size = pathFilter.size
              }

              acc['embeddedRelations.ancestors'] = filter
            }
            break
          }
          case 'field_compare': {
            const comparisons = {}
            for (const f of filter as ComparisonFilterParams[]) {
              const { field, num, comparison } = f
              const currFiled = comparisons[field]
              if (currFiled === undefined) {
                comparisons[field] = { [`$${comparison}`]: num }
              } else {
                comparisons[field] = { ...currFiled, [`$${comparison}`]: num }
              }
              acc = { ...acc, ...comparisons }
            }
            break
          }
          default:
            break
        }
        return acc
      }, {})
    }

    mongoFilter._deleting = { $eq: null } // marked for deletion

    // Todo: figure whether we need to populate 'climbs' array
    return this.collection.find(mongoFilter)
  }

  async findManyByPathHash (pathHashes: string[]): Promise<any> {
    return await this.collection.aggregate([
      { $match: { pathHash: { $in: pathHashes } } },
      { $addFields: { __order: { $indexOfArray: [pathHashes, '$pathHash'] } } },
      { $sort: { __order: 1 } }
    ]).toArray()
  }

  async listAllCountries (): Promise<any> {
    try {
      return await this.areaModel.find({ pathTokens: { $size: 1 } }).lean()
    } catch (e) {
      logger.error(e)
      return []
    }
  }

  async findOneAreaByUUID (uuid: muuid.MUUID): Promise<AreaType> {
    const rs = await this.areaModel
      .aggregate([
        { $match: { 'metadata.area_id': uuid, _deleting: { $eq: null } } },
        {
          $lookup: {
            from: 'climbs', // other collection name
            localField: 'climbs',
            foreignField: '_id',
            as: 'climbs' // clobber array of climb IDs with climb objects
          }
        },
        {
          $set: {
            'climbs.gradeContext': '$gradeContext' // manually set area's grade context to climb
          }
        }
      ])

    if (rs != null && rs.length === 1) {
      return rs[0]
    }
    throw new Error(`Area ${uuid.toString()} not found.`)
  }

  async findManyClimbsByUuids (uuidList: muuid.MUUID[]): Promise<any> {
    const rs = await this.climbModel.find().where('_id').in(uuidList)
    return rs
  }

  /**
   * Find a climb by uuid.  Also return the parent area object (crag or boulder).
   *
   * SQL equivalent:
   * ```sql
   * SELECT
   *   climbs.*,
   *   areas.ancestors as ancestors,
   *   areas.pathTokens as pathTokens,
   *   (select * from areas) as parent
   * FROM climbs, areas
   * WHERE
   *   climbs.metadata.areaRef == areas.metadata.area_id
   * ```
   * @param uuid climb uuid
   */
  async findOneClimbByUUID (uuid: muuid.MUUID): Promise<ClimbGQLQueryType | null> {
    const rs = await this.climbModel
      .aggregate([
        { $match: { _id: uuid } },
        {
          $lookup: {
            from: 'areas', // other collection name
            localField: 'metadata.areaRef',
            foreignField: 'metadata.area_id',
            as: 'parent' // add a new parent field
          }
        },
        { $unwind: '$parent' }, // Previous stage returns as an array of 1 element. 'unwind' turn it into an object.
        {
          $set: {
          // create aliases
            pathTokens: '$parent.pathTokens',
            ancestors: '$parent.ancestors'
          }
        }
      ])

    if (rs != null && rs?.length === 1) {
      return rs[0]
    }
    return null
  }

  /**
   * Find all descendants (inclusive) starting from path
   * @param path comma-separated _id's of area
   * @param isLeaf
   * @returns array of areas
   */
  async findDescendantsByPath (path: string, isLeaf: boolean = false): Promise<AreaType[]> {
    const regex = new RegExp(`^${path}`)
    const data = this.collection.find({ ancestors: regex, 'metadata.leaf': isLeaf })
    return await data.toArray()
  }

  uuid
  /**
   * Get whole db stats
   * @returns
   */
  async getStats (): Promise<StatisticsType> {
    const stats = {
      totalClimbs: 0,
      totalCrags: 0
    }
    const agg1 = await this.climbModel.countDocuments()

    const agg2 = await this.areaModel.aggregate([{ $match: { 'metadata.leaf': true } }])
      .count('totalCrags')

    if (agg2.length === 1) {
      const totalClimbs = agg1
      const totalCrags = agg2[0].totalCrags
      return {
        totalClimbs,
        totalCrags
      }
    }

    return stats
  }

  async getCragsNear (
    placeId: string,
    lnglat: [number, number],
    minDistance: number,
    maxDistance: number,
    includeCrags: boolean = false): Promise<CragsNear[]> {
    const rs = await this.areaModel.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: lnglat },
          key: 'metadata.lnglat',
          distanceField: 'distance',
          distanceMultiplier: 0.001,
          minDistance,
          maxDistance,
          query: { 'metadata.leaf': true },
          spherical: true
        }
      },
      {
        // Exclude climbs in this crag to reduce result size.
        // This will result in climbs: null
        // We'll set them to [] in the end to avoid potential unexpected null problems.
        $unset: ['climbs']
      },
      {
        // group result by 'distance' from center
        $bucket: {
          groupBy: '$distance',
          boundaries: [
            0, 48, 96, 160, 240
          ],
          default: 'theRest',
          output: {
            count: {
              $sum: 1
            },
            // Only include crags data (a lot) if needed
            crags: {
              $push: includeCrags ? '$$ROOT' : ''
            }
          }
        }
      },
      { $unset: 'crags.distance' }, // remove 'distance' field
      { $set: { 'crags.climbs': [] } }, // set to empty []
      // this is a hack to add an arbitrary token to make the graphql result uniquely identifiable for Apollo client-side cache.  Todo: look for a better way as this could be potential injection.
      { $addFields: { placeId } }])
    return rs
  }

  async findCragsWithin (bbox: BBoxType, zoom: number): Promise<any> {
    const polygon = bboxPolygon(bbox)
    const filter = {
      'metadata.lnglat': {
        $geoWithin: {
          $geometry: polygon.geometry
        }
      },
      'metadata.leaf': zoom >= 11
    }
    return await this.areaModel.find(filter).lean()
  }

  /**
   * Using the child relations we can do a graph lookup and flatten that result.
   * I've put a leniant timeout of 500ms on the query to encourage proper loading
   * patterns from api users.
   *
   * The timeout is a heuristic, sufficiently fast hardware may munch up a fair quantity
   * of memory, but the docs say that this should be 100mb in the worst case?
   * https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphLookup/#memory
   * someone more familair with mongo may want to double check that.
   */
  async descendants (ofArea?: muuid.MUUID, filter?: {
    projection?: Record<keyof Partial<IAreaProps & { parent: '' }>, boolean>
    filter?: Partial<DescendantQuery>
  }): Promise<ShadowArea[]> {
    function shadowArea (doc: Document): ShadowArea {
      return {
        area_name: doc.area_name,
        uuid: doc.uuid,
        parent: doc.parent,
        climbs: doc.climbs
      }
    }

    const pipeline: Document[] = []

    if (ofArea === undefined) {
      // in this case we can filter on the max depth
    }

    pipeline.push(...[
      {
        $match: {
          ...(ofArea !== undefined ? { 'metadata.area_id': ofArea } : {}),
          ...(filter?.filter?.maxDepth !== undefined ? { $expr: { $lte: [{ $size: '$pathTokens' }, filter?.filter?.maxDepth] } } : {}),
          _deleting: { $exists: false }
        }
      },
      {
        $project:
        {
          // We need these two fields to make the structure query,
          // all else are optional.
          _id: 1,
          children: 1,

          'metadata.area_id': filter?.projection?.uuid,
          ...filter?.projection
        }
      },
      {
        $graphLookup: {
          from: this.collection.collectionName,
          startWith: '$_id',
          connectFromField: 'children',
          connectToField: '_id',
          as: 'descendants',
          // We can pass in a max depth if it is supplied to us.
          ...(typeof filter?.filter?.maxDepth === 'number'
            ? {
                maxDepth: filter?.filter?.maxDepth
              }
            : {})
        }
      },
      {
        $unwind: {
          path: '$descendants'
        }
      },
      {
        $replaceRoot:
        {
          newRoot: '$descendants'
        }
      },
      {
        $project:
        {
          // We need these two fields to make the structure query,
          // all else are optional.
          _id: 1,
          'metadata.area_id': filter?.projection?.uuid,
          ...filter?.projection
        }
      }
    ])

    if (filter?.projection?.parent ?? false) {
      pipeline.push(
        // Sadly we need to duplicate work previously done to now look up the immediate parent of
        // the area
        {
          $lookup:
          {
            from: 'areas',
            localField: '_id',
            foreignField: 'children',
            as: 'parent'
          }
        }
      )
    }

    pipeline.push({
      $addFields:
      {
        uuid: '$metadata.area_id',
        parent: {
          $first: '$parent.metadata.area_id'
        }
      }
    })

    return await this
      .collection
      .aggregate(pipeline)
      .maxTimeMS(900)
      .map(shadowArea)
      .toArray()
  }
}

export interface DescendantQuery {
  maxDepth: number
}
