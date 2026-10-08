import 'reflect-metadata';
import mongoose from 'mongoose';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { connectDatabase } from '../../servers/04-nestjs/src/bootstrap/database.js';
import { HttpErrorFilter } from '../../servers/04-nestjs/src/http/http-exception.filter.js';
import { httpMetrics } from '../../servers/04-nestjs/src/observability/metrics.js';
import { logger } from '../../servers/04-nestjs/src/bootstrap/logger.js';

if (process.env.MONGO_URI !== 'mongodb://127.0.0.1:28027/phase0_contract_test?directConnection=true') throw new Error('Nonisolated target');
await connectDatabase();
const { AppModule } = await import('../../servers/04-nestjs/src/app.module.js');
const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ logger:false }), { logger:['error'] });
app.useGlobalFilters(new HttpErrorFilter());
const fastify = app.getHttpAdapter().getInstance();
const observations = new WeakMap<object, {finish(status:number):void}>();
fastify.addHook('onRequest', async req => { const observation = httpMetrics.observe(req.method, req.url); if(observation) observations.set(req, observation); });
fastify.addHook('onResponse', async (req, reply) => { observations.get(req)?.finish(reply.statusCode); });
fastify.get('/metrics', async (_req, reply) => reply.header('Content-Type', httpMetrics.contentType).send(await httpMetrics.render()));
await app.init();
await Promise.all(Object.values(mongoose.models).map(model => model.init()));
await app.listen({ port:5102, host:'127.0.0.1' });
process.send?.({ready:true});
process.on('message', async message => {
  if(message !== 'shutdown') return;
  await app.close();
  logger.close();
  process.disconnect?.();
});
