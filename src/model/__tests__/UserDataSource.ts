import muuid from 'uuid-mongodb'
import UserDataSource from '../UserDataSource.js'
import { UpdateProfileGQLInput } from '../../db/UserTypes.js'
import { dataFixtures as it } from '../../__tests__/fixtures/data.fixtures.js'

describe('UserDataSource', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should create a new user with just username', async ({ users }) => {
    const userUuid = muuid.v4()
    const updater = muuid.v4()
    const input: UpdateProfileGQLInput = {
      userUuid: userUuid.toUUID().toString(),
      username: 'cat',
      email: 'cat@example.com'
    }

    let u = await users.getUsername(userUuid)

    expect(u).toBeNull()

    await users.createOrUpdateUserProfile(updater, input)

    u = await users.getUsername(muuid.from(input.userUuid))

    expect(u?._id.toUUID().toString()).toEqual(userUuid.toUUID().toString())
    expect(u?.username).toEqual(input.username)
    expect(u?.updatedAt.getTime() ?? 0).toBeGreaterThan(0)
    expect(u?.updatedAt.getTime()).toBeLessThan(Date.now())
  })

  it('should create a new user from username and other updatable fields', async ({ users }) => {
    const updater = muuid.v4()
    const userUuid = muuid.v4()
    const username = 'new-test-profile'
    const input: UpdateProfileGQLInput = {
      userUuid: userUuid.toUUID().toString(),
      username,
      displayName: 'jane doe',
      bio: 'this is a test profile',
      website: 'https://example.com',
      email: 'cat@example.com'
    }

    const u = await users.getUsername(userUuid)

    expect(u).toBeNull()

    await users.createOrUpdateUserProfile(updater, input)

    let u2 = await users.getUserPublicProfile(username)

    // check selected fields
    expect(u2).toMatchObject({
      username: input.username,
      displayName: input.displayName,
      bio: input.bio,
      website: input.website,
      email: input.email
    })

    expect(u2?._id.toUUID().toString()).toEqual(input.userUuid)

    // should allow website as an empty string to clear existing value
    await users.createOrUpdateUserProfile(updater, { userUuid: input.userUuid, website: '' })

    u2 = await users.getUserPublicProfile(username)

    // verify
    expect(u2).toMatchObject({
      username: input.username,
      displayName: input.displayName,
      bio: input.bio,
      website: '',
      email: input.email
    })
  })

  it('should require an email when creating new profile', async ({ users }) => {
    const updater = muuid.v4()
    const userUuid = muuid.v4()
    const input: UpdateProfileGQLInput = {
      userUuid: userUuid.toUUID().toString(),
      username: 'woof'
    }

    await expect(
      users.createOrUpdateUserProfile(updater, input)
    ).rejects.toThrowError(/Email is required/i)
  })

  it('should enforce a waiting period for username update', async ({ users }) => {
    const updater = muuid.v4()
    const userUuid = muuid.v4()
    const input: UpdateProfileGQLInput = {
      userUuid: userUuid.toUUID().toString(),
      username: 'woof',
      email: 'cat@example.com'
    }

    await users.createOrUpdateUserProfile(updater, input)

    await expect(
      users.createOrUpdateUserProfile(updater, {
        userUuid: input.userUuid,
        username: 'woof1234'
      })
    ).rejects.toThrowError(/frequent update/i)
  })

  it('should allow username update after the waiting period', async ({ users }) => {
    const updater = muuid.v4()
    const userUuid = muuid.v4()
    const input: UpdateProfileGQLInput = {
      userUuid: userUuid.toUUID().toString(),
      username: 'winnie',
      email: 'cat@example.com'
    }

    await users.createOrUpdateUserProfile(updater, input)

    vi
      .spyOn(UserDataSource, 'calculateLastUpdatedInDays')
      .mockImplementation(() => 14)

    const newInput: UpdateProfileGQLInput = {
      userUuid: input.userUuid,
      username: 'pooh',
      bio: 'I\'m a bear'
    }
    await users.createOrUpdateUserProfile(updater, newInput)

    const updatedUser = await users.getUserPublicProfileByUuid(muuid.from(newInput.userUuid))

    expect(updatedUser?.username).toEqual(newInput.username)
  })

  it('should reject invalid website url', async ({ users }) => {
    const updater = muuid.v4()
    const userUuid = muuid.v4()
    const input: UpdateProfileGQLInput = {
      userUuid: userUuid.toUUID().toString(),
      website: 'badurl',
      email: 'cat@example.com'
    }

    await expect(
      users.createOrUpdateUserProfile(updater, input)
    ).rejects.toThrowError(/invalid website/i)
  })
})
