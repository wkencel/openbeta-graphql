import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { ChangeStream, MongoClient } from 'mongodb'
import mongoose, { Model, Mongoose } from 'mongoose'
import { checkVar, defaultPostConnect } from '../../db'
import { testStreamListener } from '../../db/edit/streamListener'
import { Mock } from 'vitest'
import { ClimbSchema } from '../../db/ClimbSchema'
import { AreaSchema } from '../../db/AreaSchema'
import { ClimbType } from '../../db/ClimbTypes'
import { AreaType } from '../../db/AreaTypes'
import MutableAreaDataSource from '../../model/MutableAreaDataSource'
import MutableClimbDataSource from '../../model/MutableClimbDataSource'
import { MediaObject } from '../../db/MediaObjectTypes'
import { MediaObjectSchema } from '../../db/MediaObjectSchema'

/**
 * In-memory Mongo replset used for testing.
 * More portable than requiring user to set up Mongo in a background Docker process.
 * Need a replset to faciliate transactions.
 */
let mongod: MongoMemoryReplSet
const onChange: Mock = vi.fn()
let stream: ChangeStream

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({
    // Stream listener listens on DB denoted by 'MONGO_DBNAME' env var.
    replSet: { count: 1, storageEngine: 'wiredTiger', dbName: checkVar('MONGO_DBNAME') }
  })
  stream = await defaultPostConnect(async () => await testStreamListener(onChange))
})

afterAll(async () => {
  await stream?.close()
  await mongoose.connection.dropDatabase()
  await mongoose.connection.close()
  await mongod.stop()
})

interface DbTestContext {
  uri: string
  db: Mongoose
  client: MongoClient
  insertDirectly: (collection: string, documents: any[]) => Promise<void>
  climbModel: Model<ClimbType>
  areaModel: Model<AreaType>
  mediaModel: Model<MediaObject>

  areas: MutableAreaDataSource
  climbs: MutableClimbDataSource
}

export const dbTest = test.extend<DbTestContext>({
  uri: async ({ task }, use) => await use(await mongod.getUri(task.id)),
  client: async ({ task, uri }, use) => {
    const client = new MongoClient(uri)
    await use(client)
    await client.close()
  },
  db: async ({ task, uri, client }, use) => {
    const mongooseInstance = await mongoose.connect(uri, {
      autoIndex: false // Create indices using defaultPostConnect instead.
    })

    mongoose.set('debug', false) // Set to 'true' to enable verbose mode
    await use(mongooseInstance)

    // Clear the collections this instance created
    await client.db(task.id).dropDatabase()
  },
  insertDirectly: async ({ task, uri }, use) => {
    /**
     * Bypass Mongoose to insert data directly into Mongo.
     * Useful for inserting data that is incompatible with Mongoose schemas for migration testing.
     * @param collection Name of collection for documents to be inserted into.
     * @param docs Documents to be inserted into collection.
     */
    const insertDirectly = async (collection: string, documents: any[]): Promise<void> => {
      const client = new MongoClient(uri)

      try {
        const database = client.db(task.id)
        const mCollection = database.collection(collection)
        const result = await mCollection.insertMany(documents)

        console.log(`${result.insertedCount} documents were inserted directly into MongoDB`)
      } finally {
        await client.close()
      }
    }

    await use(insertDirectly)
  },

  climbModel: async ({ task, db }, use) => {
    const climbModel = db.model('climbs', ClimbSchema)
    await climbModel.createIndexes()
    await use(climbModel)
  },

  areaModel: async ({ db }, use) => {
    const model = db.model('areas', AreaSchema)
    await model.createIndexes()
    await use(model)
  },

  mediaModel: async ({ db }, use) => {
    const model = db.model('media_objects', MediaObjectSchema)
    await model.createIndexes()
    await use(model)
  },

  areas: async ({ climbModel, areaModel, mediaModel, client }, use) => {
    await use(new MutableAreaDataSource({ climbModel, areaModel, mediaModel, modelOrCollection: client.db().collection('areas') }))
  },

  climbs: async ({ climbModel, areaModel, client }, use) => {
    await use(new MutableClimbDataSource({ climbModel, areaModel, modelOrCollection: client.db().collection('climbs') }))
  }
})
