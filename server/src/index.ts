import Fastify from 'fastify';

const PORT = Number(process.env.PORT ?? 3000);

function currentNow(): string {
  return process.env.VIRTUAL_NOW ?? new Date().toISOString();
}

const app = Fastify({
  logger: true,
});

app.get('/api/health', async () => {
  return { ok: true, now: currentNow() };
});

async function start(): Promise<void> {
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
