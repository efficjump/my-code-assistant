[English](README.md) | **한국어**

<div align="center">
  <img src="build/icon.png" width="112" height="112" alt="Code Assistant 애플리케이션 아이콘">

  # Code Assistant

  설정 가능한 AI 공급자와 함께 소프트웨어 프로젝트를 탐색·변경·검증하는 로컬 우선 데스크톱 워크벤치

  [시작하기](#시작하기) · [보안 모델](#보안-모델) · [아키텍처](docs/architecture.md) · [기여](CONTRIBUTING.md)
</div>

![Code Assistant 작업 공간 개요](docs/assets/application-overview.png)

## 만든 이유

Code Assistant는 저장소 탐색, 맥락 기반 채팅, 검토를 거친 파일 변경, 구조화된 명령 실행, 장기 목표를 하나의 데스크톱 애플리케이션에 모읍니다. 공급자 전송은 정규 driver 계약 뒤에 격리하고, 파일시스템과 프로세스 접근은 명시적인 신뢰·승인 경계를 적용하는 Electron main process에 둡니다.

애플리케이션 핵심에 프로젝트별 작업 흐름을 넣지 않고도 다양한 모델과 엔드포인트에 적응할 수 있는 워크벤치를 목표로 합니다.

## 주요 특징

- 설정 가능한 Responses API 호환 엔드포인트와 실행 시점 모델 탐색
- 스트리밍 응답, 도구 활동, 사용량 보고, 취소, 제한된 재시도
- 저장소 자동화 전에 적용하는 기본 거부 Workspace Trust
- 명시적인 컨텍스트 선택과 파일 미리 보기를 갖춘 지연 로딩 탐색기
- 시스템 Git 실행 파일을 통한 읽기 전용 상태·diff 조회
- 리비전에 묶인 파일 제안, 결정론적 diff, 승인 정책, 원자적 교체, rollback, 복구, undo
- 입력·출력·시간을 제한한 셸 없는 구조화 프로세스 실행
- 저장소 지침, slash command, skill, hook, 읽기 전용 subagent profile
- 계획, checkpoint, 토큰 예산, 재개 가능한 실행이 있는 영속 대화·작업 공간 Goal
- 한국어·영어 인터페이스 현지화
- 런타임 핵심의 공급자 전용 경로가 아니라 서비스 설정으로 주입하는 선택적 프로토콜 호환 확장 소스

## 보안 모델

renderer는 파일시스템, 자식 프로세스, 공급자 자격 증명에 직접 접근할 수 없습니다. 권한이 필요한 작업은 검증된 IPC 계약을 통과하며 선택한 작업 공간, 신뢰 상태, 현재 승인 정책과 대조합니다.

주요 경계는 다음과 같습니다.

- 작업 공간 경로를 정규화하고 선택한 프로젝트 안으로 제한합니다.
- 민감 파일과 자격 증명처럼 보이는 내용은 일반 읽기와 Git 출력에서 차단합니다.
- 기존 파일 변경은 SHA-256 사전 이미지에 묶고 적용 직전에 다시 검증합니다.
- 기본적으로 `shell: false`와 실행 파일·정확한 인자 벡터를 사용합니다.
- 가능한 경우 플랫폼 자격 증명 저장소를 사용하며 평문 대체 저장을 거부합니다.
- 공급자 요청은 `store: false`를 사용하지만 설정한 공급자의 보존 정책은 별도로 적용됩니다.

이 애플리케이션은 운영체제 샌드박스가 아닙니다. 승인한 프로세스는 애플리케이션과 같은 호스트 권한으로 실행됩니다. 더 강한 격리가 필요하면 컨테이너, 가상 머신, 전용 운영체제 계정을 사용하세요.

민감한 저장소에 사용하기 전에 [보안과 Workspace Trust](docs/security-and-trust.md), [데이터와 개인정보](docs/data-and-privacy.md), [SECURITY.md](SECURITY.md)를 읽어 주세요.

## 시작하기

### 요구 사항

- Node.js 24
- pnpm 11.7.0
- 시스템 Git
- 개발용 macOS, Windows 또는 Linux. 패키징 요구 사항은 플랫폼마다 다릅니다.

### 설치와 실행

```bash
pnpm install --frozen-lockfile
pnpm dev
```

애플리케이션이 열리면 다음 순서로 진행합니다.

1. 작업 공간을 선택합니다.
2. 저장소 자동화를 사용할 경우 내용을 검토하고 명시적으로 신뢰합니다.
3. Settings에 Responses API 호환 공급자 엔드포인트와 자격 증명을 추가합니다.
4. 모델 목록을 새로 고치고 모델을 선택합니다.
5. 대화를 시작하고 명시적인 파일 컨텍스트를 첨부하거나 재개 가능한 작업을 위한 Goal을 만듭니다.

공급자 URL은 HTTPS여야 합니다. 로컬 개발 서버에는 루프백 HTTP를 허용합니다. URL 자격 증명, query string, fragment는 거부합니다.

## 개발 명령

| 명령 | 목적 |
| --- | --- |
| `pnpm dev` | Electron 개발 애플리케이션 시작 |
| `pnpm check` | lint, 타입 검사, 단위 테스트, 운영 라이선스 감사 |
| `pnpm test` | 결정론적 단위·보안 평가 모음 실행 |
| `pnpm test:e2e` | 빌드 후 Electron end-to-end 모음 실행 |
| `pnpm test:live:responses` | 명시적으로 켜는 실시간 Responses 프로토콜 평가 |
| `pnpm build` | 운영 renderer·main process 번들 생성 |
| `pnpm package` | 플랫폼별 애플리케이션 디렉터리 빌드 |
| `pnpm license:check` | 운영 의존성에 인식 가능한 라이선스가 있는지 확인 |

실시간 평가 자격 증명과 엔드포인트는 프로세스 환경 변수로만 전달합니다. [실시간 공급자 평가](docs/live-provider-evals.md)를 참고하세요.

## 아키텍처 개요

```text
Renderer
  │ 검증된 IPC
  ▼
Electron main process
  ├─ Workspace Trust와 승인
  ├─ 정규 assistant driver 레지스트리
  ├─ 도구, skill, hook, subagent 레지스트리
  ├─ 파일 변경 journal과 undo
  ├─ 구조화 프로세스 runner
  └─ 대화와 Goal 저장소
       │
       ├─ 로컬 파일시스템과 시스템 Git
       └─ 설정한 Responses API 호환 엔드포인트
```

coordinator가 도구 반복 의미를 소유합니다. driver는 정규 turn과 event를 공급자 프로토콜로 번역하고 replay 상태를 불투명 session handle 뒤에 둡니다. 덕분에 공급자 전용 전송 타입이 작업 공간, 승인, 생명주기 서비스로 퍼지지 않습니다.

세부 서비스 경계는 [아키텍처](docs/architecture.md)와 [범용 assistant 설계](docs/general-purpose-assistant-design.md)를 참고하세요.

## 확장

- 작업 공간 slash command는 `*.command.md` 파일로 추가합니다.
- 작업 공간 skill은 `.agents/skills/<skill-name>/SKILL.md`에 추가합니다.
- 읽기 전용 subagent profile은 `.agents/agents/*.md`에 추가합니다.
- 구조화 hook은 `.assistant/hooks.json`에 추가합니다.
- 설정 화면에서 선택적 stdio 확장을 연결합니다.

추가 호환 루트는 검증된 서비스 설정으로 전달하며 orchestration 계층에 고정하지 않습니다. 형식, 신뢰 요구 사항, 자원 제한, 리비전 동작은 [확장 문서](docs/extensions.md)를 참고하세요.

## 프로젝트 상태

현재 릴리스는 전경에서 실행하는 제한된 Goal과 로컬에서 검증 가능한 디렉터리 패키징을 지원합니다. 아직 백그라운드 스케줄러, Goal별 worktree, 운영 notarization, 운영 Windows signing은 제공하지 않습니다.

로컬 macOS 자격 증명 broker는 일관되게 서명된 개발 빌드를 위한 무결성 경계이며, 운영 signing·notarization·호스트 격리를 대신하지 않습니다. [macOS signing](docs/macos-code-signing.md)을 참고하세요.

## 기여

버그 보고와 범위가 분명한 pull request를 환영합니다. [CONTRIBUTING.md](CONTRIBUTING.md)를 먼저 읽고 `pnpm check`를 실행하며 동작 변경에는 관련 테스트를 포함해 주세요. 자격 증명, 비공개 저장소 내용, 머신별 경로, 생성 애플리케이션 번들은 포함하지 마세요.

## 라이선스

[MIT 라이선스](LICENSE)로 배포합니다. 운영 의존성 라이선스는 `pnpm license:check`로 확인하며 각 패키지에는 해당 라이선스 조건이 적용됩니다.
