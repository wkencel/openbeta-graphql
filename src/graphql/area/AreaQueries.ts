import muuid, { MUUID } from 'uuid-mongodb'
import { AreaType, ShadowArea } from '../../db/AreaTypes'
import { Context } from '../../types'

interface StructureQuery extends Partial<{
  parent: MUUID
  filter: Partial<{
    depth: number

  }>
}> {}

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
    const data: ShadowArea[] = []
    const roots: MUUID[] = []

    console.time('structure query')

    if (params.parent !== undefined) {
      // A parent has been specified so we can eval just that node
      roots.push(params.parent)
    } else {
      roots.push(...(await areas.listAllCountries()).map(i => i.metadata.area_id))
    }

    // For each root that we're interested in, we want to scan accross
    for (const root of roots) {
      const area = await areas.findOneAreaByUUID(root)
      const parent = area.ancestors.split(',').pop()
      if (parent === undefined) continue

      data.push({ uuid: root, area_name: area.area_name, parent: muuid.from(parent) })
      // descendents takes care of its own look-ahead to make sure the query
      // does not munch up stupid bandwidth
      data.push(...(await areas.descendents(root)))
    }

    console.timeEnd('structure query')

    return data
  }
}

export default AreaQueries
