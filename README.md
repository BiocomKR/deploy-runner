# Deploy Runner

배포 스크립트 실행 + Claude 자동 커밋을 웹 UI로 제공하는 로컬 대시보드

## 설치 & 실행

```bash
npm install
npm run dev
```

http://localhost:3333 접속

## 탭 구성

### Deploy 탭
배포 스크립트를 원클릭으로 실행

- **Deploy**: 개별 프로젝트 배포 스크립트 실행
- **Deploy All**: 모든 프로젝트 순차 배포

**설정**: Deploy Settings에서 Label과 Script Path 입력

### Commit 탭
Claude CLI를 사용하여 자동 커밋

- **Commit**: Claude가 diff 분석 후 커밋 메시지 자동 생성 및 커밋
- **Commit & Push**: 커밋 후 development 브랜치에 머지하고 푸시
- **Commit All**: 모든 프로젝트 순차 커밋

**설정**: Commit Settings에서 Claude CLI 경로와 프로젝트 경로 입력
- Claude CLI Path: `which claude` 결과 입력
- Scan 버튼: 상위 디렉토리 입력 시 하위 git 프로젝트 자동 검색

## 기술 스택

- Hono (웹 프레임워크)
- Server-Sent Events (실시간 로그)

## 주의사항

- 로컬에서만 실행 (서버가 로컬 스크립트 실행)
- 모든 경로는 절대 경로로 입력
- Commit 기능은 `--dangerously-skip-permissions` 플래그 사용
