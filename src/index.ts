import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { spawn, execSync } from 'child_process';
import { accessSync, constants, readFileSync } from 'fs';
import { dirname, join } from 'path';

const app = new Hono();

// 정적 HTML 제공
app.get('/', (c) => {
  const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf-8');
  return c.html(html);
});

// 배포 SSE 엔드포인트
app.get('/api/deploy', async (c) => {
  const projectId = c.req.query('projectId');
  const script = c.req.query('script');

  if (!projectId || !script) {
    return c.text('Missing projectId or script', 400);
  }

  // 스크립트 실행 권한 확인 및 부여
  try {
    accessSync(script, constants.X_OK);
  } catch {
    try {
      execSync(`chmod +x "${script}"`);
    } catch (chmodErr) {
      return c.text(`Failed to set execute permission: ${chmodErr}`, 500);
    }
  }

  // 스크립트 경로에서 cwd 자동 추출
  const scriptDir = dirname(script);
  const cwd = scriptDir.includes('infra-gcp')
    ? scriptDir.split('infra-gcp')[0].replace(/\/$/, '')
    : scriptDir;

  return streamSSE(c, async (stream) => {
    const child = spawn('bash', [script, '--project-id', projectId, '--yes'], {
      cwd,
      env: { ...process.env }
    });

    const sendEvent = async (data: object) => {
      await stream.writeSSE({ data: JSON.stringify(data) });
    };

    child.stdout.on('data', async (data) => {
      await sendEvent({ type: 'stdout', text: data.toString() });
    });

    child.stderr.on('data', async (data) => {
      await sendEvent({ type: 'stderr', text: data.toString() });
    });

    await new Promise<void>((resolve) => {
      child.on('close', async (code) => {
        await sendEvent({ type: 'done', code });
        resolve();
      });

      child.on('error', async (err) => {
        await sendEvent({ type: 'error', text: err.message });
        resolve();
      });
    });
  });
});

const port = 3333;
console.log(`Server running at http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port
});
