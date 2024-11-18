import mongoose, { ClientSession } from 'mongoose'
import AreaDataSource from './AreaDataSource'
import { AreaType, DenormalizedAreaSummary } from '../db/AreaTypes'
import { MUUID } from 'uuid-mongodb'

export class AreaRelationsEmbeddings {
  constructor (public areaModel: AreaDataSource['areaModel']) {}

  /***
   * For a given area, ensure that the parent has a forward link to it in its embedded
   * relations.
   */
  async ensureChildReference (area: AreaType, session: ClientSession): Promise<void> {
    if (area.parent === undefined) {
      throw new Error('No child reference can be reified for this area because its parent is undefined.')
    }

    await this.areaModel.updateOne(
      { _id: area.parent },
      { $addToSet: { 'embeddedRelations.children': area._id } }
    ).session(session)
  }

  /**
   * For a given area, delete any child references that exist that are no longer
   * backed by the parent reference.
   */
  async deleteStaleReferences (area: AreaType, session: ClientSession): Promise<void> {
    await this.areaModel.updateMany(
      // The parent passed to us here is the DESIRED parent, not necessarily yet the reified
      // parent - but might be.
      { _id: { $ne: area.parent }, 'embeddedRelations.children': area._id },
      { $pull: { 'embeddedRelations.children': area._id } }
    ).session(session)
  }

  /**
   * When an area changes its parent reference there are some effects that need to be processed.
   * Its parent needs to be informed of the change, its old parent needs to have its index invalidated,
   * and all of its children may need to be informed of the change - since they hold denormalized data
   * regarding thier ancestry.
   */
  async computeEmbeddedAncestors (area: AreaType, session: ClientSession): Promise<void> {
    await Promise.all([
      // ensure the parent has a reference to this area
      this.ensureChildReference(area, session),
      // ensure there are no divorced references to this area
      this.deleteStaleReferences(area, session),
      // pass the embeddings down the hierarchy child-to-child.
      this.syncEmbeddedRelations(area, session)
    ])
  }

  /**
   * When an area name changes, there may be denormalized references to it elsewhere in the collection
   * that we would like to change.
   */
  async syncNamesInEmbeddings (area: AreaType, session: ClientSession): Promise<void> {
    await this.areaModel.updateMany(
      // TODO: My vision for this function was that the (exists.name != new.name) clause should not have been necessary,
      //  but the function goes into a spin-loop otherwise. So, perhaps a changestream is firing somewhere else.
      //  I didn't spend much time in the debugger parsing the stack, but I would like to know what's happening here.
      { 'embeddedRelations.ancestors._id': area._id, 'embeddedRelations.ancestors.name': { $ne: area.area_name } },
      { $set: { 'embeddedRelations.ancestors.$[elem].name': area.area_name } },
      { arrayFilters: [{ 'elem._id': area._id }], timestamps: false }
    ).session(session)
  }

  async computeAncestorsFor (_id: mongoose.Types.ObjectId): Promise<Array<{ ancestor: AreaType }>> {
    return await this.areaModel.aggregate([
      { $match: { _id } },
      {
        $graphLookup: {
          from: this.areaModel.collection.name,
          startWith: '$parent',
          // connect parent -> _id to trace up the tree
          connectFromField: 'parent',
          connectToField: '_id',
          as: 'ancestor',
          depthField: 'level'
        }
      },
      {
        $unwind: '$ancestor'
      },
      {
        $project: {
          _id: 0,
          ancestor: 1
        }
      },
      { $sort: { 'ancestor.level': -1 } }
    ])
  }

  /**
   * For a given area with a set parent reference, we want to perform a lookup at that node
   * to get its ancestry and then pass that ancestry context down the tree updating children.
   *
   *      .children
   * and  .ancestors
   *
   * will be updated with the relevant values.
   */
  async syncEmbeddedRelations (area: AreaSinkReference, session: ClientSession, precompute?: DenormalizedAreaSummary[]): Promise<void> {
    if (precompute === undefined) {
      precompute = (await this.computeAncestorsFor(area._id)).map(({ ancestor }) => ({
        name: ancestor.area_name,
        _id: ancestor._id,
        uuid: ancestor.metadata.area_id
      }))
    } else {
      precompute = [
        ...precompute,
        {
          name: area.area_name,
          _id: area._id,
          uuid: area.metadata.area_id
        }]
    }

    const children = await this.areaModel.find(
      { parent: area._id, _deleting: { $exists: false } },
      { _id: 1, area_name: 1, 'metadata.area_id': 1 }
    )

    await Promise.all([
      this.areaModel.updateOne(
        { _id: area._id },
        {
          'embeddedRelations.ancestors': precompute,
          // We've gone through the trouble of fetching this data, so we will update.
          'embeddedRelations.children': children.map(area => ({
            name: area.area_name,
            _id: area._id,
            uuid: area.metadata.area_id
          }))
        }
      ).session(session),
      ...children.map(async child => await this.syncEmbeddedRelations(child, session, precompute))
    ])
  }
}

interface AreaSinkReference {
  _id: mongoose.Types.ObjectId
  area_name: string
  metadata: { area_id: MUUID }
}
