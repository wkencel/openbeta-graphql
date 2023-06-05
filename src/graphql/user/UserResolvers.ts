import { User, GetUsernameReturn, UserPublicProfile } from '../../db/UserTypes.js'

const UserResolvers: object = {

  UserProfile: {
    userUuid: (node: User) => node._id.toUUID().toString()
  },

  UserPublicProfile: {
    userUuid: (node: UserPublicProfile) => node._id.toUUID().toString()
  },

  UsernameDetail: {
    userUuid: (node: GetUsernameReturn) => node._id.toUUID().toString(),
    lastUpdated: (node: GetUsernameReturn) => node.updatedAt
  }
}

export default UserResolvers
