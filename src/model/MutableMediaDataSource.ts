import { ApolloServerErrorCode } from '@apollo/server/errors'
import { GraphQLError } from 'graphql'
import mongoose from 'mongoose'
import muuid from 'uuid-mongodb'

import MediaDataSource from './MediaDataSource.js'
import { EntityTag, EntityTagDeleteInput, MediaObject, MediaObjectGQLInput, AddTagEntityInput, NewMediaObjectDoc } from '../db/MediaObjectTypes.js'
import MutableAreaDataSource from './MutableAreaDataSource.js'
import { muuidToString } from '../utils/helpers.js'

export default class MutableMediaDataSource extends MediaDataSource {
  areaDS = MutableAreaDataSource.getInstance()

  async getEntityDoc ({ entityUuid, entityType }: Omit<AddTagEntityInput, 'mediaId'>): Promise<EntityTag> {
    let newEntityTagDoc: EntityTag
    switch (entityType) {
      case 0: {
        // Check whether the climb referencing this tag exists before we allow
        // the tag to be added
        const climb = await this.areaDS.findOneClimbByUUID(entityUuid)

        if (climb == null) {
          throw new GraphQLError(`Climb with id: ${entityUuid.toUUID().toString()} not found`, {
            extensions: {
              code: ApolloServerErrorCode.BAD_USER_INPUT
            }
          })
        }

        newEntityTagDoc = {
          _id: new mongoose.Types.ObjectId(),
          targetId: entityUuid,
          type: entityType,
          ancestors: climb.parent.embeddedRelations.ancestors.map(i => muuidToString(i.uuid)).join(','),
          climbName: climb.name,
          areaName: climb.parent.area_name,
          lnglat: climb.metadata.lnglat
        }

        break
      }

      case 1: {
        // Check whether the area referencing this tag exists before we allow
        // the tag to be added
        const area = await this.areaDS.findOneAreaByUUID(entityUuid)

        if (area == null) {
          throw new GraphQLError(`Area with id: ${entityUuid.toUUID().toString()} not found`, {
            extensions: {
              code: ApolloServerErrorCode.BAD_USER_INPUT
            }
          })
        }

        newEntityTagDoc = {
          _id: new mongoose.Types.ObjectId(),
          targetId: entityUuid,
          type: entityType,
          ancestors: area.embeddedRelations.ancestors.map(i => i.uuid).join(','),
          areaName: area.area_name,
          lnglat: area.metadata.lnglat
        }

        break
      }

      default: throw new GraphQLError(`Entity type ${entityType} not supported.`, {
        extensions: {
          code: ApolloServerErrorCode.BAD_USER_INPUT
        }
      })
    }
    return newEntityTagDoc
  }

  /**
   * Add a new entity tag to a media object.  `mediaId`, `entityUuid`, `entityType`
   * together uniquely identify the entity tag.  Providing the same 3 IDs with a
   * different `topoData` to update the existing entity tag.
   * @returns the new EntityTag or the one being updated.
   */
  async upsertEntityTag ({ mediaId, entityUuid, entityType, topoData }: AddTagEntityInput): Promise<EntityTag> {
    // Find the entity we want to tag
    const newEntityTagDoc = await this.getEntityDoc({ entityUuid, entityType })
    newEntityTagDoc.topoData = topoData

    // Use `bulkWrite` because we can't upsert an array element in a document.
    // See https://www.mongodb.com/community/forums/t/how-to-update-nested-array-using-arrayfilters-but-if-it-doesnt-find-a-match-it-should-insert-new-values/245505
    const bulkOperations: any [] = [{
      updateOne: {
        filter: {
          _id: new mongoose.Types.ObjectId(mediaId)
        },
        update: {
          $pull: {
            entityTags: { targetId: entityUuid }
          }
        }
      }
    }, {
      // We treat 'entityTags' like a Set - can't add a new tag the same climb/area id twice.
      // See https://stackoverflow.com/questions/33576223/using-mongoose-mongodb-addtoset-functionality-on-array-of-objects
      updateOne: {
        filter: {
          _id: new mongoose.Types.ObjectId(mediaId),
          'entityTags.targetId': { $ne: entityUuid }
        },
        update: {
          $push: {
            entityTags: newEntityTagDoc
          }
        }
      }
    }]

    await this.mediaObjectModel.bulkWrite(bulkOperations, { ordered: true })

    return newEntityTagDoc
  }

  /**
   *  Remove a climb/area entity tag
   */
  async removeEntityTag ({ mediaId, tagId }: EntityTagDeleteInput): Promise<boolean> {
    const rs = await this.mediaObjectModel
      .updateOne<MediaObject>(
      {
        _id: mediaId,
        'entityTags._id': tagId
      },
      {
        $pull: {
          entityTags: { _id: tagId }
        }
      },
      { multi: true })
      .orFail(new GraphQLError('Tag not found', {
        extensions: {
          code: ApolloServerErrorCode.BAD_USER_INPUT
        }
      }))
      .lean()

    return rs.modifiedCount === 1
  }

  /**
   * Add one or more media objects.  The embedded entityTag may have one tag.
   */
  async addMediaObjects (input: MediaObjectGQLInput[]): Promise<MediaObject[]> {
    const docs: NewMediaObjectDoc[] = await Promise.all(input.map(async entry => {
      const { userUuid: userUuidStr, mediaUrl, width, height, format, size, entityTag } = entry
      let newTag: EntityTag | undefined
      if (entityTag != null) {
        newTag = await this.getEntityDoc({
          entityType: entityTag.entityType,
          entityUuid: muuid.from(entityTag.entityId)
        })
      }

      return ({
        mediaUrl,
        width,
        height,
        format,
        size,
        userUuid: muuid.from(userUuidStr),
        ...newTag != null && { entityTags: [newTag] }
      })
    }))

    // Do not set `lean = true` as it will not return 'createdAt'
    const rs = await this.mediaObjectModel.insertMany(docs)
    return rs != null ? rs : []
  }

  /**
   * Delete one media object.
   */
  async deleteMediaObject (mediaId: mongoose.Types.ObjectId): Promise<boolean> {
    const filter = { _id: mediaId }
    const rs = await this.mediaObjectModel.find(filter).orFail(new GraphQLError(`Media Id not found ${mediaId.toString()}`, {
      extensions: {
        code: ApolloServerErrorCode.BAD_USER_INPUT
      }
    }))

    if ((rs[0].entityTags?.length ?? 0) > 0) {
      throw new GraphQLError('Cannot delete media object with non-empty tags. Delete tags first.', {
        extensions: {
          code: ApolloServerErrorCode.BAD_USER_INPUT
        }
      })
    }

    const rs2 = await this.mediaObjectModel.deleteMany(filter)
    return rs2.deletedCount === 1
  }

  static instance: MutableMediaDataSource

  static getInstance (): MutableMediaDataSource {
    if (MutableMediaDataSource.instance == null) {
      MutableMediaDataSource.instance = new MutableMediaDataSource({ modelOrCollection: mongoose.connection.db.collection('media') })
    }
    return MutableMediaDataSource.instance
  }
}
