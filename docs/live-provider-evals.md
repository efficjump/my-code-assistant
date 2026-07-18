# 실제 Responses API 공급자와 장기 Goal 평가

기본 테스트는 외부 모델을 호출하지 않습니다. 실제 Responses API 호환 endpoint와 tool-call 변환을 검증할 때만 별도 suite를 명시적으로 실행합니다. 이 driver smoke와 실제 Electron 앱에서 수행하는 장기 Goal 검증은 서로 다른 범위이며 한쪽 성공을 다른 쪽의 성공으로 간주하지 않습니다.

## 실행 조건

다음 환경값을 모두 실행 시점에 전달합니다. 값은 설정 파일이나 저장소에 기록하지 않습니다.

```bash
RUN_LIVE_RESPONSES_EVALS=1 \
RESPONSES_LIVE_BASE_URL=http://127.0.0.1:PORT/v1 \
RESPONSES_LIVE_MODEL=MODEL_ID \
RESPONSES_LIVE_API_KEY=REDACTED \
RESPONSES_LIVE_ITERATIONS=5 \
RESPONSES_LIVE_TIMEOUT_MS=120000 \
pnpm test:live:responses
```

`RESPONSES_LIVE_API_KEY`는 인증이 없는 loopback 공급자에서는 생략할 수 있습니다. Base URL은 HTTPS 또는 loopback HTTP만 허용하며 URL 내부 credential, query, fragment는 거부합니다.

## 자동 driver smoke 평가 내용

- `/models`에서 설정한 모델이 실제로 발견되는지 확인합니다.
- 매 iteration마다 새로운 nonce와 fresh driver session을 생성합니다.
- strict function tool을 두 단계 연속 호출하고 각 arguments를 schema로 검증합니다.
- provider가 native function call 또는 지원되는 textual envelope 중 어느 형식을 반환하더라도 canonical tool call로 수렴해야 합니다.
- tool protocol 원문은 text delta로 노출되지 않아야 합니다.
- 각 단계의 call ID가 중복되지 않아야 하며 tool result가 다음 turn에 정상 연결돼야 합니다.

모델이 생성한 문장 자체는 합격 조건으로 사용하지 않습니다. canonical event, tool name, 동적 nonce, schema-valid arguments, call identity만 평가합니다.

이 suite는 모델 discovery와 provider protocol adapter를 검증하지만 다음 항목은 실행하지 않습니다.

- packaged Electron 앱의 SettingsStore와 macOS credential backend
- 실제 Workspace Trust·approval UI·mutation journal·구조화 command 실행
- 여러 bounded run 사이의 Goal plan/checkpoint 연속성
- Goal frontier 집중, read-only churn recovery와 forced lifecycle revision binding
- 생성한 React/Spring Boot 등 실제 프로젝트의 dependency build와 화면 동작

## 장기 Goal live 검증

장기 Goal 변경을 검증할 때는 production package와 사용자가 선택한 실제 workspace에서 별도 시나리오를 수행합니다. 목적이나 프레임워크 이름을 테스트 코드에 고정하지 않고, 현재 검증할 workspace에서 파일 변경과 실행 검증이 모두 필요한 objective를 사용합니다.

1. 변경 전 workspace 상태와 기대 검증 명령을 기록하고, provider·model·workspace·Trust가 준비된 production package를 실행합니다.
2. Goal을 생성해 **지금 실행**으로 시작하고 각 bounded run의 provider turn, token usage, read/effect tool, plan revision과 checkpoint revision을 기록합니다.
3. 현재 plan의 첫 `in_progress`, 없으면 첫 `pending` 항목이 work focus로 전달되는지 확인합니다. 완료 항목 전체를 반복해 읽는 것은 progress로 세지 않습니다.
4. 구현·명령·외부 작업 frontier에서는 설정된 work round 비율을 읽기만 소비한 뒤 보정이 발생하고, lifecycle 직전에는 필요한 effect tool만 허용하는 recovery가 최대 한 번 실행되는지 확인합니다. 성공한 effect가 없다면 구체적인 approval·validation·execution failure가 blocker evidence로 남아야 합니다.
5. plan/checkpoint/finish는 일반 work transcript와 분리된 turn에서 각각 하나만 호출되고 revision-binding audit가 남는지 확인합니다. 별도의 deterministic provider fixture에서는 모델이 잘못된 `expectedRevision`을 생성해도 host가 provider turn 직전 snapshot revision을 결합하고, 그 뒤 발생한 실제 외부 revision 변경은 repository CAS가 거부하는지 함께 검증합니다.
6. active run 중 pause·종료·편집을 요청해 취소 과정의 fallback checkpoint가 revision을 올려도 사용자 요청이 settled revision에 적용되는지 확인합니다. 취소 뒤 별도 actor가 변경한 race는 덮어쓰지 않아야 합니다.
7. 앱을 닫았다 다시 연 뒤 Goal과 최신 plan/checkpoint가 유지되고 다음 **지금 실행**이 첫 미완료 frontier부터 계속되는지 확인합니다. 현재 구현은 background scheduler나 앱 종료 중 자동 실행을 제공하지 않습니다.
8. 모델의 최종 문장 대신 workspace diff, host tool receipt, 명령 exit status, 실제 build/test와 필요 시 실행 화면으로 결과를 판정합니다. plan/checkpoint가 있어도 필요한 effect나 검증이 없으면 Goal 완료로 판정하지 않습니다.

최소 기록 항목은 다음과 같습니다.

| 범주 | 기록할 값 |
| --- | --- |
| 공급자 | driver ID, model ID, 실행 시점의 server/model version 식별 정보 |
| run | run 수, 각 outcome, elapsed time, provider turn과 token usage |
| work | read 수, effect 시도·적용·실패 종류, 변경 path, command exit status |
| lifecycle | plan/checkpoint/finish 호출 수, Goal·plan revision, revision-binding·churn audit event |
| 결과 | 독립 build/test 결과, 앱 재시작 연속성, UI에서 확인한 최종 상태 |

API key, raw Authorization header, 전체 prompt/tool payload, 파일 내용과 사용자 개인 경로는 이 기록에 넣지 않습니다. 수치와 결과는 실제 실행에서 관찰한 값만 남기며 미실행·추정 항목은 명확히 구분합니다.

## 데이터와 비용

- API key, raw request, raw response, prompt 및 tool arguments를 파일에 저장하지 않습니다.
- 이 suite는 실제 모델 비용과 GPU 시간을 사용하며 결과가 모델 버전과 serving template에 영향을 받을 수 있습니다.
- 기본 `pnpm test`와 CI에서는 `tests/live/**`를 제외합니다.
- 반복 횟수와 timeout에는 코드 기본값을 두지 않고 실행자가 환경에 맞는 bounded 값을 명시합니다.
- 장기 Goal live 검증은 workspace를 실제로 변경하고 host process를 실행할 수 있으므로 전용 fixture 또는 복구 가능한 작업공간에서 승인 범위를 확인한 뒤 수행합니다.

실패 시에는 live suite 출력의 failure code와 로컬 provider 로그를 별도로 확인합니다. provider 로그를 공유할 때는 Authorization header와 prompt/tool payload를 먼저 제거해야 합니다.
