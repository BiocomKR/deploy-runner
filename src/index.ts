import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { spawn, execSync } from 'child_process';
import { accessSync, constants, readFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import sharp from 'sharp';

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
    // 터미널 환경과 동일하게 gcloud 사용자 계정 사용
    const env = {
      ...process.env,
      // 서비스 어카운트 대신 사용자 계정(ai@biocom.kr) 사용
      CLOUDSDK_CORE_ACCOUNT: 'ai@biocom.kr',
      // 서비스 어카운트 키 환경변수 제거 (사용자 인증 사용)
      GOOGLE_APPLICATION_CREDENTIALS: '',
    };

    const child = spawn('bash', [script, '--project-id', projectId, '--yes'], {
      cwd,
      env,
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

// 공통 SSE 실행 함수
function runCommandSSE(command: string, args: string[], cwd: string) {
  return async (stream: any) => {
    const sendEvent = async (data: object) => {
      await stream.writeSSE({ data: JSON.stringify(data) });
    };

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: true,
    });

    child.stdout.on('data', async (data: Buffer) => {
      await sendEvent({ type: 'stdout', text: data.toString() });
    });

    child.stderr.on('data', async (data: Buffer) => {
      await sendEvent({ type: 'stderr', text: data.toString() });
    });

    await new Promise<void>((resolve) => {
      child.on('close', async (code: number) => {
        await sendEvent({ type: 'done', code });
        resolve();
      });

      child.on('error', async (err: Error) => {
        await sendEvent({ type: 'error', text: err.message });
        resolve();
      });
    });
  };
}

// Claude Code로 커밋 생성 SSE 엔드포인트
app.get('/api/commit', async (c) => {
  const cwd = c.req.query('cwd');
  const claudePath = c.req.query('claudePath');
  console.log('[COMMIT] Request received:', cwd, 'claudePath:', claudePath);
  if (!cwd) return c.text('Missing cwd', 400);
  if (!claudePath) return c.text('Missing claudePath', 400);

  return streamSSE(c, async (stream) => {
    const sendEvent = async (data: object) => {
      await stream.writeSSE({ data: JSON.stringify(data) });
    };

    console.log('[COMMIT] Running claude CLI with execSync...');
    const command = `${claudePath} -p 'git diff를 확인하고 변경사항에 맞는 커밋 메시지를 작성해서 커밋해줘. 코드 수정 없이 커밋만 해. 커밋 prefix는 feat/fix/refactor/chore/docs 중 적절한 것을 사용해.' --dangerously-skip-permissions --input-format text`;

    try {
      const stdout = execSync(command, { cwd, env: process.env, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' });
      console.log('[COMMIT] stdout:', stdout.slice(0, 100));
      await sendEvent({ type: 'stdout', text: stdout });
      await sendEvent({ type: 'done', code: 0 });
    } catch (error: any) {
      console.log('[COMMIT] Error:', error.message);
      if (error.stdout) {
        console.log('[COMMIT] stdout:', error.stdout.slice(0, 100));
        await sendEvent({ type: 'stdout', text: error.stdout });
      }
      if (error.stderr) {
        console.log('[COMMIT] stderr:', error.stderr.slice(0, 100));
        await sendEvent({ type: 'stderr', text: error.stderr });
      }
      await sendEvent({ type: 'done', code: error.status ?? 1 });
    }
  });
});

// Git Push SSE 엔드포인트
app.get('/api/push', async (c) => {
  const cwd = c.req.query('cwd');
  if (!cwd) return c.text('Missing cwd', 400);

  return streamSSE(c, runCommandSSE('git', ['push'], cwd));
});

// Commit & Push to development SSE 엔드포인트
app.get('/api/commit-and-push-dev', async (c) => {
  const cwd = c.req.query('cwd');
  const claudePath = c.req.query('claudePath');
  if (!cwd) return c.text('Missing cwd', 400);
  if (!claudePath) return c.text('Missing claudePath', 400);

  // Claude로 커밋 → development에 머지 → 푸시 → 원래 브랜치 복귀
  return streamSSE(c, async (stream: any) => {
    const sendEvent = async (data: object) => {
      await stream.writeSSE({ data: JSON.stringify(data) });
    };

    // 1. Claude로 커밋 (execSync 사용)
    await sendEvent({ type: 'stdout', text: '>>> Step 1: Creating commit with Claude...\n' });
    const command = `${claudePath} -p 'git diff를 확인하고 변경사항에 맞는 커밋 메시지를 작성해서 커밋해줘. 코드 수정 없이 커밋만 해. 커밋 prefix는 feat/fix/refactor/chore/docs 중 적절한 것을 사용해.' --dangerously-skip-permissions --input-format text`;

    let commitResult = 0;
    try {
      const stdout = execSync(command, { cwd, env: process.env, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' });
      await sendEvent({ type: 'stdout', text: stdout });
    } catch (error: any) {
      if (error.stdout) await sendEvent({ type: 'stdout', text: error.stdout });
      if (error.stderr) await sendEvent({ type: 'stderr', text: error.stderr });
      commitResult = error.status ?? 1;
    }

    if (commitResult !== 0) {
      await sendEvent({ type: 'done', code: commitResult });
      return;
    }

    // 2. development에 머지 및 푸시
    await sendEvent({ type: 'stdout', text: '\n>>> Step 2: Merging to development and pushing...\n' });
    const mergeScript = `
      CURRENT_BRANCH=$(git branch --show-current) && \
      git checkout development && \
      git pull origin development && \
      git merge $CURRENT_BRANCH --no-edit && \
      git push origin development && \
      git checkout $CURRENT_BRANCH
    `;
    const mergeResult = await new Promise<number>((resolve) => {
      const child = spawn('bash', ['-c', mergeScript], { cwd, env: process.env, shell: true });
      child.stdout.on('data', async (data: Buffer) => { await sendEvent({ type: 'stdout', text: data.toString() }); });
      child.stderr.on('data', async (data: Buffer) => { await sendEvent({ type: 'stderr', text: data.toString() }); });
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });

    await sendEvent({ type: 'done', code: mergeResult });
  });
});

// 개발 환경 배포 SSE 엔드포인트
app.get('/api/deploy-dev', async (c) => {
  const cwd = c.req.query('cwd');
  const script = c.req.query('script');
  const projectId = c.req.query('projectId');

  if (!cwd || !script || !projectId) {
    return c.text('Missing cwd, script, or projectId', 400);
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

  // 커밋 → development 머지 → 푸시 → 배포 스크립트 실행
  return streamSSE(c, async (stream: any) => {
    const sendEvent = async (data: object) => {
      await stream.writeSSE({ data: JSON.stringify(data) });
    };

    // 1. development에 머지 및 푸시
    await sendEvent({ type: 'stdout', text: '>>> Step 1: Merging to development and pushing...\n' });
    const mergeScript = `
      CURRENT_BRANCH=$(git branch --show-current) && \
      git checkout development && \
      git pull origin development && \
      git merge $CURRENT_BRANCH --no-edit && \
      git push origin development && \
      git checkout $CURRENT_BRANCH
    `;
    const mergeResult = await new Promise<number>((resolve) => {
      const child = spawn('bash', ['-c', mergeScript], { cwd, env: process.env, shell: true });
      child.stdout.on('data', async (data: Buffer) => { await sendEvent({ type: 'stdout', text: data.toString() }); });
      child.stderr.on('data', async (data: Buffer) => { await sendEvent({ type: 'stderr', text: data.toString() }); });
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });

    if (mergeResult !== 0) {
      await sendEvent({ type: 'done', code: mergeResult });
      return;
    }

    // 2. 배포 스크립트 실행
    await sendEvent({ type: 'stdout', text: '\n>>> Step 2: Deploying to development environment...\n' });

    const env = {
      ...process.env,
      CLOUDSDK_CORE_ACCOUNT: 'ai@biocom.kr',
      GOOGLE_APPLICATION_CREDENTIALS: '',
    };

    const deployResult = await new Promise<number>((resolve) => {
      const child = spawn('bash', [script, '--project-id', projectId, '--env', 'development', '--yes'], {
        cwd,
        env,
      });
      child.stdout.on('data', async (data: Buffer) => { await sendEvent({ type: 'stdout', text: data.toString() }); });
      child.stderr.on('data', async (data: Buffer) => { await sendEvent({ type: 'stderr', text: data.toString() }); });
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });

    await sendEvent({ type: 'done', code: deployResult });
  });
});

// Git Merge to development & Push SSE 엔드포인트
app.get('/api/merge-dev', async (c) => {
  const cwd = c.req.query('cwd');
  if (!cwd) return c.text('Missing cwd', 400);

  // 현재 브랜치 저장 → development 체크아웃 → 머지 → 푸시 → 원래 브랜치로 복귀
  const script = `
    CURRENT_BRANCH=$(git branch --show-current) && \
    git checkout development && \
    git pull origin development && \
    git merge $CURRENT_BRANCH --no-edit && \
    git push origin development && \
    git checkout $CURRENT_BRANCH
  `;

  return streamSSE(c, runCommandSSE('bash', ['-c', script], cwd));
});

// PNG to WebP 변환 API (sharp 사용)
app.post('/api/convert-webp', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const quality = parseInt(formData.get('quality') as string) || 80;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const webpBuffer = await sharp(buffer)
      .webp({ quality })
      .toBuffer();

    return new Response(new Uint8Array(webpBuffer), {
      headers: {
        'Content-Type': 'image/webp',
        'Content-Disposition': `attachment; filename="${file.name.replace(/\.(png|jpg|jpeg)$/i, '.webp')}"`,
        'X-Original-Size': buffer.length.toString(),
        'X-Converted-Size': webpBuffer.length.toString(),
      },
    });
  } catch (error: any) {
    console.error('WebP conversion error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Git 프로젝트 자동 검색 API
app.get('/api/scan-git-projects', async (c) => {
  const rootPath = c.req.query('path');
  if (!rootPath) return c.json({ error: 'Missing path' }, 400);

  if (!existsSync(rootPath)) {
    return c.json({ error: 'Path does not exist' }, 400);
  }

  const projects: { id: string; label: string; path: string }[] = [];

  try {
    const entries = readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const projectPath = join(rootPath, entry.name);
        const gitPath = join(projectPath, '.git');
        if (existsSync(gitPath)) {
          projects.push({
            id: entry.name.toLowerCase().replace(/\s+/g, '-'),
            label: entry.name,
            path: projectPath,
          });
        }
      }
    }
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }

  return c.json({ projects });
});

const port = 3333;

// Claude CLI 경로는 클라이언트에서 전달받음

console.log(`Server running at http://localhost:${port}`);

const server = serve({
  fetch: app.fetch,
  port
}) as any;

// SSE 연결 타임아웃 비활성화 (5분)
server.timeout = 300000;
server.keepAliveTimeout = 300000;
