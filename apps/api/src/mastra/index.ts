import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { elevenLabsRoutes } from '../elevenlabs/routes';
import { dashboardRoutes } from '../dashboard/routes';
import { requestRoutes } from '../requests/routes';
import { changesFeedRoute } from '../shared/changes-feed';
import { alertWorkflow, m4ApiRoutes, readingAlertWorkflow, textAgent } from '../m4';

export const mastra = new Mastra({
  server: {
    apiRoutes: [...elevenLabsRoutes, ...dashboardRoutes, ...requestRoutes, ...m4ApiRoutes, changesFeedRoute],
  },
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  agents: { textAgent },
  workflows: { alertWorkflow, readingAlertWorkflow },
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: process.env.TURSO_DATABASE_URL || 'file:./mastra.db',
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    }),
    domains: {
      observability: await new DuckDBStore().getStore('observability'),
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
