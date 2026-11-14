# 개인용 WorldMonitor 실행

## 개인용 실행 (컨테이너 불필요)

이 포크의 개인용 실행 경로는 Node.js 24 프로세스 하나에서 화면과 로컬 API를 제공합니다.
공식 서비스로의 API 대체 요청과 데스크톱 키 릴레이를 끕니다.
한국어가 기본 언어이며 사용자가 선택한 언어와 `?lang=` 설정은 유지합니다.

1. Node.js 24에서 `npm ci`를 실행합니다.
2. `.env.local`에 `WM_PERSONAL_PASSWORD` (16자 이상)와 `WM_SESSION_SECRET` (32자 이상)을 설정합니다. 실제 키와 비밀번호는 커밋하지 않습니다.
3. `npm run build:personal`로 화면과 API를 빌드합니다.
4. `npm run start:personal`을 실행하고 `http://127.0.0.1:3000/dashboard`를 엽니다. 기본 사용자 이름은 `owner`입니다.

`WM_PERSONAL_USERNAME`, `WM_PERSONAL_PORT`, `WM_PERSONAL_HOST`로 접속 설정을 바꿀 수 있습니다.
외부에서는 HTTPS 역방향 프록시를 통해 접속합니다. 기본 루프백 바인딩을 유지하고 프록시에서 TLS를 종료합니다.
개인 비밀번호는 화면과 API 모두를 보호하며, 수집용 API 키는 서버 환경에만 둡니다.

### 저장소와 기능 범위

개인 서버는 Docker, nginx, supervisord, Vercel, Railway 없이 실행할 수 있습니다.
그러나 현재 수집기는 Redis를 데이터·갱신 시각·이력의 저장소로 사용합니다.
이를 설정하지 않으면 저장된 데이터가 필요한 패널은 사용할 수 없습니다.
개인용 실행에서는 원격 공유 Redis 대신 루프백 주소의 로컬 저장소만 사용합니다.
기존 수집기의 원자적 쓰기·만료·이력 보존을 대체하기 전에는 Redis 제거가 완료된 것이 아닙니다.
외부 데이터 제공자에 대한 네트워크 요청과 별도 API 키는 여전히 필요합니다.

### Railway 없이 공급망 시나리오 계산

```sh
npm run scenario:local -- --snapshot seeds.json --scenario hormuz-tanker-blockade --country KR --severity 50 --output result.json
```

`seeds.json`은 `seed-meta:supply_chain:chokepoint-exposure` 및
`supply-chain:exposure:{ISO2}:{HS2}:v1` 키를 디코딩된 JSON 값에 매핑한 객체입니다.
이 명령은 네트워크·Redis·Railway 없이 기존 계산식을 실행합니다.
원본 날짜와 누락·불완전 데이터 표시는 유지됩니다. 최신 데이터 수집이나 스냅샷 생성은 이 명령이 수행하지 않습니다.
결과는 상대 노출도이며 실제 손실 금액이나 사건 발생 확률이 아닙니다.

SQLite에 저장된 노출 데이터를 사용할 때는 `--snapshot seeds.json` 대신
`--database personal.sqlite`를 지정합니다. SQLite는 별도 서버나 컨테이너 없이
파일에 데이터를 보관하며, 시나리오 실행 시에는 읽기 전용으로 엽니다.
기존 수집기의 Redis 쓰기 경로가 모두 SQLite로 전환된 것은 아닙니다.

기존 데이터 수집기를 사용하는 동안에는 로컬 Redis와
`npm run start:local-store` 호환 어댑터를 실행할 수 있습니다.
어댑터는 기본적으로 `127.0.0.1:8079`에서만 수신하고 `SRH_TOKEN`을 요구합니다.
수집기와 API의 `UPSTASH_REDIS_REST_URL`에는 이 로컬 주소를,
`UPSTASH_REDIS_REST_TOKEN`에는 같은 토큰을 설정합니다. 이 경로에는 Docker가 필요 없습니다.
