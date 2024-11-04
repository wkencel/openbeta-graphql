import muuid, { MUUID } from 'uuid-mongodb'
import { AreaType, ShadowArea } from '../../db/AreaTypes'
import { Context } from '../../types'
import { validate } from 'uuid'

interface StructureQuery {
  parent: MUUID
  filter: Partial<{
    depth: number
  }>
}

const AreaQueries = {
  cragsWithin: async (_, { filter }, { dataSources }: Context): Promise<AreaType | null> => {
    const { areas } = dataSources
    const { bbox, zoom } = filter
    return await areas.findCragsWithin(bbox, zoom)
  },

  countries: async (_, params, { dataSources }: Context): Promise<AreaType[]> => {
    const { areas } = dataSources
    return await areas.listAllCountries()
  },

  structure: async (_, params: StructureQuery, { dataSources }: Context): Promise<ShadowArea[]> => {
    const { areas } = dataSources
    if (!(typeof params.parent === 'string' && validate(params.parent))) {
      throw new Error('Malformed UUID string')
    }

    return await areas.descendents(muuid.from(params.parent))
  }
}

export default AreaQueries
