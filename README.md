# Deploy Runner

로컬 배포 스크립트를 웹 UI에서 실행할 수 있는 대시보드

## 설치

```bash
npm install
```

## 실행

```bash
npm run dev   # 개발 모드 (hot reload)
npm start     # 프로덕션 모드
```

http://localhost:3333 접속

## 사용법

### 1. 프로젝트 추가
1. Settings 버튼 클릭
2. "+ Add Project" 클릭
3. Label과 Script Path 입력
4. Save 클릭

### 2. 배포 실행
- 개별 배포: 각 프로젝트 버튼 클릭
- 전체 배포: "Deploy All" 버튼 클릭

### 3. 설정 예시

| 필드 | 예시 |
|------|------|
| Label | api-dev |
| Script Path | /path/to/your/project/scripts/deploy.sh |

## 기능

- 원클릭 배포
- 실시간 로그 스트리밍 (SSE)
- 다중 프로젝트 관리
- Deploy All (순차 배포)
- 자동 chmod +x 권한 부여
- LocalStorage 설정 저장

## 기술 스택

- [Hono](https://hono.dev/) - 경량 웹 프레임워크
- Server-Sent Events (SSE) - 실시간 로그
- Vanilla JS - 프론트엔드

## 주의사항

- 이 도구는 **로컬에서 실행**해야 합니다 (서버가 로컬 스크립트를 실행하는 구조)
- 스크립트 경로는 절대 경로로 입력하세요
