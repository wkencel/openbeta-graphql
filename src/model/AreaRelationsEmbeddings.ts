import mongoose from 'mongoose'
import AreaDataSource from './AreaDataSource'
import { AreaType } from '../db/AreaTypes'

export class AreaRelationsEmbeddings {
  constructor (public areaModel: AreaDataSource['areaModel']) {}

  /***
   * For a given area, ensure that the parent has a forward link to it in its embedded
   * relations.
   */
  async ensureChildReference (area: AreaType): Promise<void> {
    if (area.parent === undefined) {
      throw new Error('No child reference can be reified for this area because its parent is undefined.')
    }

    await this.areaModel.updateOne(
      { _id: area.parent },
      { $addToSet: { 'embeddedRelations.children': area._id } }
    )
  }

  /**
   * For a given area, delete any child references that exist that are no longer
   * backed by the parent reference.
   */
  async deleteStaleReferences (area: AreaType): Promise<void> {
    await this.areaModel.updateMany(
      { _id: { $ne: area.parent }, 'embeddedRelations.children': area._id },
      { $pull: { 'embeddedRelations.children': area._id } }
    )
  }

  /**
   * When an area changes its parent reference there are some effects that need to be processed.
   * Its parent needs to be informed of the change, its old parent needs to have its index invalidated,
   * and all of its children may need to be informed of the change - since they hold denormalized data
   * regarding thier ancestry.
   */
  async computeEmbeddedAncestors (area: AreaType): Promise<void> {
    await Promise.all([
      // ensure the parent has a reference to this area
      this.ensureChildReference(area),
      // ensure there are no divorced references to this area
      this.deleteStaleReferences(area)
    ])
  }

  /**
   * When an area name changes, there may be denormalized references to it elsewhere in the collection
   * that we would like to change.
   */
  async syncNamesInEmbeddings (area: AreaType): Promise<void> {
    await this.areaModel.updateMany(
      // TODO: My vision for this function was that the (exists.name != new.name) clause should not have been necessary,
      //  but the function goes into a spin-loop otherwise. So, perhaps a changestream is firing somewhere else.
      //  I didn't spend much time in the debugger parsing the stack, but I would like to know what's happening here.
      { 'embeddedRelations.ancestors._id': area._id, 'embeddedRelations.ancestors.name': { $ne: area.area_name } },
      { $set: { 'embeddedRelations.ancestors.$[elem].name': area.area_name } },
      { arrayFilters: [{ 'elem._id': area._id }], timestamps: false }
    )
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
}
