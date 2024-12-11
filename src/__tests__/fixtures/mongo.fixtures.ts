import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { ChangeStream, MongoClient } from 'mongodb'
import mongoose from 'mongoose'
import { checkVar, defaultPostConnect } from '../../db'
import { testStreamListener } from '../../db/edit/streamListener'
import { Mock } from 'vitest'
import MutableAreaDataSource from '../../model/MutableAreaDataSource'
import MutableClimbDataSource from '../../model/MutableClimbDataSource'
import BulkImportDataSource from '../../model/BulkImportDataSource'
import ChangeLogDataSource from '../../model/ChangeLogDataSource'
import MutableMediaDataSource from '../../model/MutableMediaDataSource'
import MutableOrganizationDataSource from '../../model/MutableOrganizationDataSource'
import TickDataSource from '../../model/TickDataSource'
import UserDataSource from '../../model/UserDataSource'

/**
 * In-memory Mongo replset used for testing.
 * More portable than requiring user to set up Mongo in a background Docker process.
 * Need a replset to faciliate transactions.
 */
let mongod: MongoMemoryReplSet
const onChange: Mock = vi.fn()
let stream: ChangeStream
let uri: string

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({
    // Stream listener listens on DB denoted by 'MONGO_DBNAME' env var.
    replSet: { count: 1, storageEngine: 'wiredTiger', dbName: checkVar('MONGO_DBNAME') }
  })

  uri = await mongod.getUri(checkVar('MONGO_DBNAME'))
  await mongoose.connect(uri, { autoIndex: false })
  mongoose.set('debug', false) // Set to 'true' to enable verbose mode

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
  client: MongoClient
  insertDirectly: (collection: string, documents: any[]) => Promise<void>

  areas: MutableAreaDataSource
  climbs: MutableClimbDataSource
  bulkImport: BulkImportDataSource
  organizations: MutableOrganizationDataSource
  ticks: TickDataSource
  history: ChangeLogDataSource
  media: MutableMediaDataSource
  users: UserDataSource
}

export const dbTest = test.extend<DbTestContext>({
  uri: async ({ }, use) => await use(uri),
  client: async ({ uri }, use) => {
    const client = new MongoClient(uri)
    await use(client)
    await client.close()
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

  areas: async ({ }, use) => await use(MutableAreaDataSource.getInstance()),
  climbs: async ({ }, use) => await use(MutableClimbDataSource.getInstance()),
  bulkImport: async ({ }, use) => await use(BulkImportDataSource.getInstance()),
  organizations: async ({ }, use) => await use(MutableOrganizationDataSource.getInstance()),
  ticks: async ({ }, use) => await use(TickDataSource.getInstance()),
  history: async ({ }, use) => await use(ChangeLogDataSource.getInstance()),
  media: async ({ }, use) => await use(MutableMediaDataSource.getInstance()),
  users: async ({ }, use) => await use(UserDataSource.getInstance())
})
