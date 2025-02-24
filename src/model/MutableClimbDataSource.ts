import { GraphQLError } from 'graphql'
import { ApolloServerErrorCode } from '@apollo/server/errors'
import { ClientSession } from 'mongoose'
import muid, { MUUID } from 'uuid-mongodb'

import { createGradeObject, gradeContextToGradeScales, sanitizeDisciplines } from '../GradeUtils.js'
import { getAreaModel } from '../db/AreaSchema.js'
import { AreaDocumnent } from '../db/AreaTypes.js'
import { ChangeRecordMetadataType } from '../db/ChangeLogType.js'
import { getClimbModel } from '../db/ClimbSchema.js'
import { ClimbChangeDocType, ClimbChangeInputType, ClimbEditOperationType, ClimbType, IPitch } from '../db/ClimbTypes.js'
import { aggregateCragStats } from '../db/utils/Aggregate.js'
import { sanitize, sanitizeStrict } from '../utils/sanitize.js'
import ChangeLogDataSource from './ChangeLogDataSource.js'
import ClimbDataSource from './ClimbDataSource.js'
import ExperimentalUserDataSource from './ExperimentalUserDataSource.js'
import MutableAreaDataSource from './MutableAreaDataSource.js'
import { withTransaction } from '../utils/helpers.js'

export interface AddOrUpdateClimbsOptions {
  userId: MUUID
  parentId: MUUID
  changes: ClimbChangeInputType[]
  session?: ClientSession
}

export default class MutableClimbDataSource extends ClimbDataSource {
  experimentalUserDataSource = ExperimentalUserDataSource.getInstance()

  async _addOrUpdateClimbs (userId: MUUID, session: ClientSession, parentId: MUUID, userInput: ClimbChangeInputType[]): Promise<string[]> {
    const newClimbIds = new Array<MUUID>(userInput.length)
    for (let i = 0; i < newClimbIds.length; i++) {
      // make sure there's some input
      if (Object.keys(userInput[i]).length === 0) {
        throw new GraphQLError(`Climb ${userInput[i]?.id ?? ''} doesn't have any updated fields.`, {
          extensions: {
            code: ApolloServerErrorCode.BAD_USER_INPUT
          }
        })
      }
      const userinputId = userInput[i]?.id

      if (userinputId == null) {
        newClimbIds[i] = muid.v4()
      } else {
        newClimbIds[i] = muid.from(userinputId)
      }
    }

    const existingIds = await this.climbModel.find({ _id: { $in: newClimbIds } }).select('_id')

    interface IdMapType {
      id: MUUID
      existed: boolean
    }

    // A list of ID objects to track whether the ID exists in the DB
    const idList = newClimbIds.reduce<IdMapType[]>((acc, curr) => {
      if (existingIds.some(item => item._id.toUUID().toString() === curr.toUUID().toString())) {
        acc.push({ id: curr, existed: true })
      } else {
        acc.push({ id: curr, existed: false })
      }
      return acc
    }, [])

    const opType = ClimbEditOperationType.updateClimb
    const change = await ChangeLogDataSource.getInstance().create(session, userId, opType)

    const parentFilter = { 'metadata.area_id': parentId }

    const parent = await this.areaModel
      .findOne(parentFilter).session(session)
      .orFail(new GraphQLError(`Area with id: ${parentId.toUUID().toString()} not found`, {
        extensions: {
          code: ApolloServerErrorCode.BAD_USER_INPUT
        }
      }))

    const _change: ChangeRecordMetadataType = {
      user: userId,
      historyId: change._id,
      prevHistoryId: parent._change?.historyId,
      operation: ClimbEditOperationType.updateClimb,
      seq: 0
    }
    parent.set({ _change })

    // does the parent area have subareas?
    if (parent.children.length > 0) {
      throw new GraphQLError('You can only add climbs to a crag or a bouldering area (an area that doesn\'t contain other areas)', {
        extensions: {
          code: ApolloServerErrorCode.BAD_USER_INPUT
        }
      })
    }

    if (!parent.metadata.leaf) {
      // this is the first time we're adding climbs to an area so 'leaf' hasn't been set yet
      parent.metadata.leaf = true
    }

    const cragGradeScales = gradeContextToGradeScales[parent.gradeContext]
    if (cragGradeScales == null) {
      throw new Error(`Area ${parent.area_name} (${parent.metadata.area_id.toUUID().toString()}) has  invalid grade context: '${parent.gradeContext}'`)
    }

    const newDocs: ClimbChangeDocType[] = []

    for (let i = 0; i < userInput.length; i++) {
      // when adding new climbs we require name and disciplines
      if (!idList[i].existed && userInput[i].name == null) {
        throw new GraphQLError(`Can't add new climbs without name. (Index[index=${i}])`, {
          extensions: {
            code: ApolloServerErrorCode.BAD_USER_INPUT
          }
        })
      }

      // See https://github.com/OpenBeta/openbeta-graphql/issues/244
      const author = userInput[i].experimentalAuthor
      let experimentalUserId: MUUID | null = null
      if (author != null) {
        experimentalUserId = await this.experimentalUserDataSource.updateUser(session, author.displayName, author.url)
      }

      const typeSafeDisciplines = sanitizeDisciplines(userInput[i]?.disciplines)

      const grade = userInput[i].grade

      const newGradeObj = grade != null && typeSafeDisciplines != null // only update grades when both grade str and disciplines obj exist
        ? createGradeObject(grade, typeSafeDisciplines, cragGradeScales)
        : null

      const pitches = userInput[i].pitches

      const newPitchesWithIDs = pitches != null
        ? pitches.map((pitch): IPitch => {
          const { id, ...partialPitch } = pitch // separate 'id' input and rest of the pitch properties to avoid duplicate id and _id
          if (partialPitch.pitchNumber === undefined) {
            throw new GraphQLError('Each pitch in a multi-pitch climb must have a pitchNumber representing its sequence in the climb. Please ensure that every pitch is numbered.', {
              extensions: {
                code: ApolloServerErrorCode.BAD_USER_INPUT
              }
            })
          }
          return {
            _id: muid.from(id ?? muid.v4()), // populate _id
            // feed rest of pitch data
            ...partialPitch,
            parentId: muid.from(partialPitch.parentId ?? newClimbIds[i]),
            pitchNumber: partialPitch.pitchNumber
          }
        })
        : null

      const { description, location, protection, name, fa, length, boltsCount } = userInput[i]

      // Make sure we don't update content = {}
      // See https://www.mongodb.com/community/forums/t/mongoservererror-invalid-set-caused-by-an-empty-object-is-not-a-valid-value/148344/2
      const content = {
        ...description != null && { description: sanitize(description) },
        ...location != null && { location: sanitize(location) },
        ...protection != null && { protection: sanitize(protection) }
      }

      /**
       * Construct the document object to send to Mongo.
       *
       * Idiomatic way to only include the field if it's not null:
       * ```
       * ...field != null && { fieldName: field }
       * ```
       */
      const doc: ClimbChangeDocType = {
        _id: newClimbIds[i],
        ...name != null && { name: sanitizeStrict(name) },
        ...newGradeObj != null && { grades: newGradeObj },
        ...typeSafeDisciplines != null && { type: typeSafeDisciplines },
        gradeContext: parent.gradeContext,
        ...fa != null && { fa },
        ...length != null && length > 0 && { length },
        ...boltsCount != null && boltsCount >= 0 && { boltsCount }, // Include 'boltsCount' if it's defined and its value is 0 (no bolts) or greater
        ...newPitchesWithIDs != null && { pitches: newPitchesWithIDs },
        ...Object.keys(content).length > 0 && { content },
        metadata: {
          areaRef: parent.metadata.area_id,
          lnglat: parent.metadata.lnglat,
          ...userInput[i]?.leftRightIndex != null && { left_right_index: userInput[i].leftRightIndex }
        },
        ...!idList[i].existed && { createdBy: experimentalUserId ?? userId },
        ...idList[i].existed && { updatedBy: userId },
        _change: {
          user: experimentalUserId ?? userId,
          historyId: change._id,
          prevHistoryId: undefined,
          operation: opType,
          seq: 0
        }
      }
      newDocs.push(doc)
    }

    const bulk = newDocs.map(doc => ({
      updateOne: {
        filter: { _id: doc._id },
        update: [{
          $set: {
            ...doc,
            _change: {
              ...doc._change,
              prevHistoryId: '$_change.historyId'
            }
          }
        }],
        upsert: true
      }
    }))

    const rs = (await this.climbModel.bulkWrite(bulk, { session }))

    if (rs.ok === 1) {
      const idList: MUUID[] = []
      const idStrList: string[] = []
      Object.values(rs.upsertedIds).forEach(value => {
        idList.push(value)
        idStrList.push(value.toUUID().toString())
      })

      if (idList.length > 0) {
        parent.set({ climbs: parent.climbs.concat(idList) })
      }

      await parent.save()

      await updateStats(parent, session, _change)

      if (idStrList.length === newClimbIds.length) {
        return idStrList
      }
      return newClimbIds.map(entry => entry.toUUID().toString())
    } else {
      return []
    }
  }

  async addOrUpdateClimbsWith ({ userId, parentId, changes, session }: AddOrUpdateClimbsOptions): Promise<string[]> {
    return await this.addOrUpdateClimbs(userId, parentId, changes, session)
  }

  /**
   * Update one or climbs (or boulder problems).  Add climb to the area if it doesn't exist.
   * @param parentId parent area id
   * @param changes
   * @returns a list of updated (or newly added) climb IDs
   */
  async addOrUpdateClimbs (userId: MUUID, parentId: MUUID, changes: ClimbChangeInputType[], sessionCtx?: ClientSession): Promise<string[]> {
    const session = sessionCtx ?? await this.areaModel.startSession()
    if (session.inTransaction()) {
      return await this._addOrUpdateClimbs(userId, session, parentId, changes)
    } else {
      return await withTransaction(session, async () => await this._addOrUpdateClimbs(userId, session, parentId, changes)) ?? []
    }
  }

  /**
   * Delete one or more climbs by climb ID.
   * @param userId User performing the action
   * @param parentId Parent area ID
   * @param idListStr Array of climb IDs
   * @returns number of climbs was deleted
   */
  async deleteClimbs (userId: MUUID, parentId: MUUID, idList: MUUID[]): Promise<number> {
    const session = await this.areaModel.startSession()
    let ret = 0

    // withTransaction() doesn't return the callback result
    // see https://jira.mongodb.org/browse/NODE-2014
    await session.withTransaction(
      async (session) => {
        const changeset = await ChangeLogDataSource.getInstance().create(session, userId, ClimbEditOperationType.deleteClimb)
        const _change: ChangeRecordMetadataType = {
          user: userId,
          historyId: changeset._id,
          operation: ClimbEditOperationType.deleteClimb,
          seq: 0
        }
        // Remove climb IDs from parent.climbs[]
        await this.areaModel.updateOne(
          { 'metadata.area_id': parentId },
          {
            $pullAll: { climbs: idList },
            $set: {
              _change,
              updatedBy: userId
            }
          },
          { session })

        // Mark climbs delete
        const filter = {
          _id: { $in: idList },
          _deleting: { $eq: null }
        }
        const rs = await this.climbModel.updateMany(
          filter,
          [{
            $set: {
              _deleting: new Date(),
              updatedBy: userId,
              _change
            }
          }],
          {
            upserted: false,
            session
          }).lean()
        ret = rs.modifiedCount
        await updateStats(parentId, session, _change)
      })
    return ret
  }

  static instance: MutableClimbDataSource

  static getInstance (): MutableClimbDataSource {
    if (MutableClimbDataSource.instance == null) {
      // Why suppress TS error? See: https://github.com/GraphQLGuide/apollo-datasource-mongodb/issues/88
      // @ts-expect-error
      MutableClimbDataSource.instance = new MutableClimbDataSource({ modelOrCollection: getClimbModel() })
    }
    return MutableClimbDataSource.instance
  }
}

/**
 * Update stats for an area and its ancestors
 * @param areaIdOrAreaCursor
 * @param session
 * @param changeRecord
 */
const updateStats = async (areaIdOrAreaCursor: MUUID | AreaDocumnent, session: ClientSession, changeRecord: ChangeRecordMetadataType): Promise<void> => {
  let area: AreaDocumnent
  if ((areaIdOrAreaCursor as AreaDocumnent).totalClimbs != null) {
    area = areaIdOrAreaCursor as AreaDocumnent
  } else {
    area = await getAreaModel().findOne({ 'metadata.area_id': areaIdOrAreaCursor as MUUID }).session(session).orFail()
  }

  await area.populate<{ climbs: ClimbType[] }>({ path: 'climbs', model: getClimbModel() })
  area.set({
    totalClimbs: area.climbs.length,
    aggregate: aggregateCragStats(area.toObject())
  })
  await area.save()
  await MutableAreaDataSource.getInstance().updateLeafStatsAndGeoData(session, changeRecord, area)
}
