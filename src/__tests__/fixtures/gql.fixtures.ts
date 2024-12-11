import { ApolloServer, BaseContext } from '@apollo/server'
import express, { Application } from 'express'
import { dbTest } from './mongo.fixtures'
import { QueryAPIProps } from '../../utils/testUtils'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { expressMiddleware } from '@apollo/server/dist/esm/express4'
import bodyParser from 'body-parser'
import { applyMiddleware } from 'graphql-middleware'
import { localDevBypassAuthContext } from '../../auth/local-dev/middleware'
import localDevBypassAuthPermissions from '../../auth/local-dev/permissions'
import { graphqlSchema } from '../../graphql/resolvers'
import BulkImportDataSource from '../../model/BulkImportDataSource'
import ChangeLogDataSource from '../../model/ChangeLogDataSource'
import MutableMediaDataSource from '../../model/MutableMediaDataSource'
import TickDataSource from '../../model/TickDataSource'
import UserDataSource from '../../model/UserDataSource'
import cors from 'cors'
import MutableOrganizationDataSource from '../../model/MutableOrganizationDataSource'
import { muuidToString } from '../../utils/helpers'
import muuid, { MUUID } from 'uuid-mongodb'
import { AreaType } from '../../db/AreaTypes'



interface ServerTestFixtures {
  ctx: {
    server: ApolloServer<BaseContext>
    app: Application
  },
  query: (opts: QueryAPIProps) => Promise<request.Response>,
  user: MUUID,
  userUuid: string,

  usa: AreaType,
  ca: AreaType,
  wa: AreaType,
  or: AreaType
}


export const serverTest = dbTest.extend<ServerTestFixtures>({
  ctx: async ({ task, db, climbs, areas }, use) => {
    const schema = applyMiddleware(
      graphqlSchema,
      (localDevBypassAuthPermissions).generate(graphqlSchema)
    )
    const dataSources = ({
      climbs,
      areas,
      bulkImport: BulkImportDataSource.getInstance(),
      organizations: MutableOrganizationDataSource.getInstance(),
      ticks: TickDataSource.getInstance(),
      history: ChangeLogDataSource.getInstance(),
      media: MutableMediaDataSource.getInstance(),
      users: UserDataSource.getInstance()
    })
  
    const app = express()
  
    const server = new ApolloServer({
      schema,
      introspection: false,
      plugins: []
    })
    // server must be started before applying middleware
    await server.start()
  
    const context = localDevBypassAuthContext
  
    app.use('/',
      bodyParser.json({ limit: '10mb' }),
      cors<cors.CorsRequest>(),
      express.json(),
      expressMiddleware(server, {
        context: async ({ req }) => ({ dataSources, ...await context({ req }) })
      })
    )


    await use({
      app, server
    })
    await server.stop()
  },

  query: async ({ctx}, use) => {
    await use(
      async ({
        query,
        operationName,
        variables,
        userUuid = '',
        roles = [],
        endpoint = '/'
      }: QueryAPIProps) => {
        // Avoid needing to pass in actual signed tokens.
        const jwtSpy = vi.spyOn(jwt, 'verify')
        jwtSpy.mockImplementation(() => {
          return {
            // Roles defined at https://manage.auth0.com/dashboard/us/dev-fmjy7n5n/roles
            'https://tacos.openbeta.io/roles': roles,
            'https://tacos.openbeta.io/uuid': userUuid
          }
        })
      
        const queryObj = { query, operationName, variables }
        let req = request(ctx.app)
          .post(endpoint)
          .send(queryObj)
      
        if (userUuid != null) {
          req = req.set('Authorization', 'Bearer placeholder-jwt-see-SpyOn')
        }
      
        return await req
      }
    )
  },

  user: async ({ task }, use) => await use(muuid.mode('relaxed').from(task.id)),
  userUuid: async ({ user }, use) => await use(muuidToString(user)),

  usa: async ({  areas }, use) => await use(await areas.addCountry('usa')),
  ca: async ({ user, usa, areas }, use) => await use(await areas.addArea(user, 'CA', usa.metadata.area_id)),
  wa: async ({ user, usa, areas }, use) => await use(await areas.addArea(user, 'WA', usa.metadata.area_id)),
  or: async ({ user, usa, areas }, use) => await use(await areas.addArea(user, 'OR', usa.metadata.area_id))
})
