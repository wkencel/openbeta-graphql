import mongoose from 'mongoose'
import { getAreaModel } from '../db'

export async function computeEmbeddedRelations (rootId: mongoose.Types.ObjectId): Promise<void> {
  const areaModel = getAreaModel()
  const result = await areaModel.aggregate([
    {
      $match: { _id: rootId }
    },
    {
      $graphLookup: {
        from: 'areas',
        startWith: '$parent',
        connectFromField: 'parent',
        connectToField: '_id',
        as: 'computed_ancestors',
        depthField: 'depth'
      }
    },
    {
      $addFields: {
        ancestorIndex: { $map: { input: '$computed_ancestors', as: 'ancestor', in: '$$ancestor._id' } },
        pathTokens: { $map: { input: '$computed_ancestors', as: 'ancestor', in: '$$ancestor.area_name' } },
        children: [], // Initialize empty children array
        ancestors: { $map: { input: '$computed_ancestors', as: 'ancestor', in: '$$ancestor.area_name' } }
      }
    },
    {
      $project: {
        ancestors: 1,
        ancestorIndex: 1,
        pathTokens: 1,
        children: 1
      }
    }
  ])

  throw new Error('not implemented yet')
}
