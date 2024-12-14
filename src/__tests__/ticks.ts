import { TickInput, TickType } from '../db/TickTypes.js'
import { UpdateProfileGQLInput } from '../db/UserTypes.js'
import { muuidToString } from '../utils/helpers.js'
import { gqlTest } from './fixtures/gql.fixtures.js'

interface LocalContext {
  singleTickData: TickInput
  tick: TickType
}

const it = gqlTest.extend<LocalContext>({
  singleTickData: async ({ userUuid }, use) => {
    await use({
      name: 'Route One',
      notes: 'Nice slab',
      climbId: 'c76d2083-6b8f-524a-8fb8-76e1dc79833f',
      userId: userUuid,
      style: 'Lead',
      attemptType: 'Onsight',
      dateClimbed: new Date('2016-07-20T17:30:15+05:30'),
      grade: '5.8',
      source: 'MP'
    })
  },
  tick: async ({ ticks, singleTickData }, use) => {
    await use(await ticks.addTick(singleTickData))
  }
})

describe('ticks API', () => {
  describe('queries', () => {
    const userQuery = `
      query userTicks($userId: MUUID, $username: String) {
        userTicks(userId: $userId, username: $username) {
          _id
          name
          notes
          climbId
          style
          attemptType
          dateClimbed
          grade
          userId
        }
      }
    `
    const userTickByClimbQuery = `
      query userTicksByClimbId($userId: String, $climbId: String) {
        userTicksByClimbId(userId: $userId, climbId: $climbId) {
          _id
          name
          notes
          climbId
          style
          attemptType
          dateClimbed
          grade
          userId
        }
      }
    `

    it('queries by userId', async ({ userUuid, profile, tick, query }) => {
      const response = await query({
        query: userQuery,
        variables: { userId: muuidToString(profile._id) },
        userUuid
      })

      expect(response.statusCode).toBe(200)
      const res = response.body.data.userTicks
      expect(res).toHaveLength(1)
      expect(res[0].name).toBe(tick.name)
    })

    it('queries by username', async ({ userUuid, profile, tick, query }) => {
      const response = await query({
        query: userQuery,
        variables: { username: profile.username },
        userUuid
      })
      expect(response.statusCode).toBe(200)
      const res = response.body.data.userTicks
      expect(res).toHaveLength(1)
      expect(res[0].name).toBe(tick.name)
    })

    it('queries by userId and climbId', async ({ tick, query, userUuid }) => {
      const response = await query({
        query: userTickByClimbQuery,
        variables: { userId: userUuid, climbId: tick.climbId },
        userUuid
      })
      expect(response.statusCode).toBe(200)
      const res = response.body.data.userTicksByClimbId
      expect(res).toHaveLength(1)
      expect(res[0].name).toBe(tick.name)
    })
  })

  describe('mutations', () => {
    const createQuery = `
      mutation ($input: Tick!) {
        tick: addTick(input: $input) {
          _id
          name
          notes
          climbId
          userId
          style
          attemptType
          dateClimbed
          grade
          source
        }
      }
    `
    const updateQuery = `
      mutation ($input: TickFilter!) {
        tick: editTick(input: $input) {
          _id
          name
          notes
          climbId
          userId
          style
          attemptType
          dateClimbed
          grade
          source
        }
      }
    `
    it('creates and updates a tick', async ({ query, userUuid, singleTickData }) => {
      const createResponse = await query({
        query: createQuery,
        variables: { input: singleTickData },
        userUuid,
        roles: ['user_admin']
      })

      expect(createResponse.statusCode).toBe(200)
      const createTickRes = createResponse.body.data.tick
      expect(createTickRes.name).toBe(singleTickData.name)
      expect(createTickRes.notes).toBe(singleTickData.notes)
      expect(createTickRes.climbId).toBe(singleTickData.climbId)
      expect(createTickRes.userId).toBe(singleTickData.userId)
      expect(createTickRes.style).toBe(singleTickData.style)
      expect(createTickRes.attemptType).toBe(singleTickData.attemptType)
      expect(createTickRes.dateClimbed).toBe(new Date(singleTickData.dateClimbed).getTime())
      expect(createTickRes.grade).toBe(singleTickData.grade)
      expect(createTickRes.source).toBe(singleTickData.source)
      expect(createTickRes._id).toBeTruthy()

      const updateResponse = await query({
        query: updateQuery,
        variables: {
          input: {
            _id: createTickRes._id,
            updatedTick: {
              name: 'Updated Route One',
              climbId: 'new climb id',
              userId: userUuid,
              dateClimbed: '2022-11-10',
              grade: 'new grade',
              source: 'OB'
            }
          }
        },
        userUuid,
        roles: []
      })

      expect(updateResponse.statusCode).toBe(200)
      expect(updateResponse.body.data.tick.name).toBe('Updated Route One')
    })
  })
})
