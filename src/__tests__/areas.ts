import { ApolloServer } from '@apollo/server'
import muuid, { MUUID } from 'uuid-mongodb'
import { jest } from '@jest/globals'
import MutableAreaDataSource from '../model/MutableAreaDataSource.js'
import MutableOrganizationDataSource from '../model/MutableOrganizationDataSource.js'
import { AreaType } from '../db/AreaTypes.js'
import { OrganizationEditableFieldsType, OrganizationType, OrgType } from '../db/OrganizationTypes.js'
import { queryAPI, setUpServer } from '../utils/testUtils.js'
import { muuidToString } from '../utils/helpers.js'
import { InMemoryDB } from '../utils/inMemoryDB.js'
import express from 'express'

jest.setTimeout(60000)

describe('areas API', () => {
  let server: ApolloServer
  let user: muuid.MUUID
  let userUuid: string
  let app: express.Application
  let inMemoryDB: InMemoryDB

  // Mongoose models for mocking pre-existing state.
  let areas: MutableAreaDataSource
  let organizations: MutableOrganizationDataSource
  let usa: AreaType
  let ca: AreaType
  let wa: AreaType

  beforeAll(async () => {
    ({ server, inMemoryDB, app } = await setUpServer())
    // Auth0 serializes uuids in "relaxed" mode, resulting in this hex string format
    // "59f1d95a-627d-4b8c-91b9-389c7424cb54" instead of base64 "WfHZWmJ9S4yRuTicdCTLVA==".
    user = muuid.mode('relaxed').v4()
    userUuid = muuidToString(user)
  })

  beforeEach(async () => {
    await inMemoryDB.clear()
    areas = MutableAreaDataSource.getInstance()
    organizations = MutableOrganizationDataSource.getInstance()
    usa = await areas.addCountry('usa')
    ca = await areas.addArea(user, 'CA', usa.metadata.area_id)
    wa = await areas.addArea(user, 'WA', usa.metadata.area_id)
  })

  afterAll(async () => {
    await server.stop()
    await inMemoryDB.close()
  })

  describe('queries', () => {
    const areaQuery = `
      query area($input: ID) {
        area(uuid: $input) {
          uuid
          organizations {
            orgId
          }
        }
      }
    `
    let alphaFields: OrganizationEditableFieldsType
    let alphaOrg: OrganizationType

    beforeEach(async () => {
      alphaFields = {
        displayName: 'USA without CA Org',
        associatedAreaIds: [usa.metadata.area_id],
        excludedAreaIds: [ca.metadata.area_id]
      }
      alphaOrg = await organizations.addOrganization(user, OrgType.localClimbingOrganization, alphaFields)
        .then((res: OrganizationType | null) => {
          if (res === null) throw new Error('Failure mocking organization.')
          return res
        })
    })

    it('retrieves an area omitting organizations that exclude it', async () => {
      const response = await queryAPI({
        query: areaQuery,
        operationName: 'area',
        variables: { input: ca.metadata.area_id },
        userUuid,
        app
      })
      expect(response.statusCode).toBe(200)
      const areaResult = response.body.data.area
      expect(areaResult.uuid).toBe(muuidToString(ca.metadata.area_id))
      // Even though alphaOrg associates with ca's parent, usa, it excludes
      // ca and so should not be listed.
      expect(areaResult.organizations).toHaveLength(0)
    })

    it.each([userUuid, undefined])('retrieves an area and lists associated organizations', async (userId) => {
      const response = await queryAPI({
        query: areaQuery,
        operationName: 'area',
        variables: { input: wa.metadata.area_id },
        userUuid: userId,
        app
      })

      expect(response.statusCode).toBe(200)
      const areaResult = response.body.data.area
      expect(areaResult.uuid).toBe(muuidToString(wa.metadata.area_id))
      expect(areaResult.organizations).toHaveLength(1)
      expect(areaResult.organizations[0].orgId).toBe(muuidToString(alphaOrg.orgId))
    })
  })

  describe('area structure API', () => {
    const structureQuery = `
        query structure($parent: ID!) {
          structure(parent: $parent) {
            parent
            uuid
            area_name
            climbs
          }
        }
    `

    // Structure queries do not do write operations so we can build this once
    beforeEach(async () => {
      const maxDepth = 4
      const maxBreadth = 3

      // So for the purposes of this test we will do a simple tree
      async function grow (from: MUUID, depth: number = 0): Promise<void> {
        if (depth >= maxDepth) return
        for (const idx of Array.from({ length: maxBreadth }, (_, i) => i + 1)) {
          const newArea = await areas.addArea(user, `${depth}-${idx}`, from)
          await grow(newArea.metadata.area_id, depth + 1)
        }
      }

      await grow(usa.metadata.area_id)
    })

    it('retrieves the structure of a given area', async () => {
      const response = await queryAPI({
        query: structureQuery,
        operationName: 'structure',
        variables: { parent: usa.metadata.area_id },
        userUuid,
        app
      })

      expect(response.statusCode).toBe(200)
    })

    it('should allow no parent to be supplied and get a shallow result', async () => {
      const response = await queryAPI({
        query: `
        query structure {
          structure {
            parent
            uuid
            area_name
            climbs
          }
        }
    `,
        operationName: 'structure',
        userUuid,
        app
      })

      expect(response.statusCode).toBe(200)
    })

    it('should allow calling of the setAreaParent gql endpoint.', async () => {
      const testArea = await areas.addArea(muuid.from(userUuid), 'A Rolling Stone', usa.metadata.area_id)

      const response = await queryAPI({
        query: `
          mutation SetAreaParent($area: ID!, $newParent: ID!) {
            setAreaParent(area: $area, newParent: $newParent) {
              areaName
              area_name
            }
          }
        `,
        operationName: 'SetAreaParent',
        userUuid,
        app,
        // Move it to canada
        variables: { area: testArea.metadata.area_id, newParent: ca.metadata.area_id }
      })

      console.log(response.body)
      expect(response.statusCode).toBe(200)
    })
  })
})
