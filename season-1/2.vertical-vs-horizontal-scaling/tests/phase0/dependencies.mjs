import { createRequire } from 'node:module';

// Reuse the server's locked tooling. No global packages or runtime downloads.
export const serverRequire = createRequire(new URL('../../servers/02-express/package.json', import.meta.url));
const swaggerRequire = createRequire(serverRequire.resolve('swagger-jsdoc'));
export const yaml = swaggerRequire('js-yaml');
export const SwaggerParser = swaggerRequire('@apidevtools/swagger-parser');
