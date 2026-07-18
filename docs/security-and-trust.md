# 보안과 Workspace Trust

## 기본 원칙

저장소 파일, 사용자 프롬프트, Skill, MCP 서버, 모델 출력은 모두 잠재적으로 신뢰할 수 없는 입력입니다. 사용자가 워크스페이스를 신뢰해도 다음 경계는 해제되지 않습니다.

- 워크스페이스 realpath containment
- 민감 파일·binary·크기 제한
- strict IPC/tool schema
- 파일 변경과 프로세스 실행의 사용자 승인
- action hash, content revision, preimage hash 확인
- child process 환경 정리, 시간·출력 제한
- credential ciphertext marker·AAD 검증과 지원 backend 부재 시 평문 fallback 거부

즉 Workspace Trust는 “이 저장소가 무해하다”는 인증서가 아니라, 자동 저장소 조사와 저장소 소유 확장 기능을 켜는 명시적 결정입니다.

## 신뢰 상태별 기능

| 기능 | 신뢰 전 | 신뢰 후 |
| --- | ---: | ---: |
| 사용자가 직접 선택한 파일을 컨텍스트로 읽기 | 가능 | 가능 |
| 자동 파일 탐색·검색·읽기 도구 | 차단 | 가능 |
| Git status/diff | UI에서 명시적 조회 가능, agent 자동 사용은 차단 | 가능 |
| `AGENTS.md`와 구성된 추가 지침 소스 | 읽지 않음 | context 경로에 맞게 로드 |
| `*.command.md` 사용자 프롬프트 | 발견·확장 차단 | 가능 |
| 저장소 Skills | 발견·로드 차단 | 가능 |
| 파일 변경 제안·적용 | 차단 | 기본은 별도 승인, 사용자 설정의 bounded 파일 정책과 완전히 일치하면 자동 승인 가능 |
| 명령 실행 | 차단 | 기본은 별도 승인, canonical 실행 파일·argv·cwd·timeout·network 규칙과 완전히 일치하면 자동 승인 가능 |
| 워크스페이스 `.mcp.json` 실행 | 차단 | config revision에 묶인 spawn 승인 필요 |

신뢰 기록은 정규화된 실제 경로에서 만든 SHA-256 fingerprint에 묶입니다. 폴더가 이동하면 fingerprint가 달라져 다시 신뢰해야 합니다. 기록 파일은 versioned JSON으로 원자 교체하며 지원 플랫폼에서 owner-only 권한을 설정합니다.

## 저장소 지침 계층

저장소를 신뢰한 경우에만 현재 context 경로의 ancestor를 root부터 가장 구체적인 디렉터리까지 탐색합니다. 각 디렉터리에서는 다음 순서를 사용합니다.

1. `AGENTS.override.md`가 있으면 같은 디렉터리의 `AGENTS.md` 대신 사용
2. override가 없으면 `AGENTS.md` 사용
3. 서비스 구성에 추가 source group이 있으면 각 group의 첫 번째 존재 파일을 추가
4. 다음 하위 디렉터리로 이동

예를 들어 context가 `src/api/handler.ts`이고 모든 파일이 존재하면 대략 다음처럼 구성됩니다.

```text
AGENTS.override.md
src/AGENTS.md
src/api/AGENTS.md
```

각 layer는 path, 종류, precedence, byte 수, 로드 상태를 유지합니다. 빈 파일, 민감 내용, 개별/전체 byte limit을 넘는 파일은 지침으로 주입하지 않고 상태만 보고합니다.

저장소 지침은 사용자 요청, 승인 요건, containment, secret 정책보다 우선하지 않습니다. 일반 소스 파일과 도구 결과에 “이전 지시를 무시하라” 같은 문장이 있어도 저장소 지침으로 승격하지 않습니다.

## 승인 정책과 exact approval

자동 승인 정책은 현재 canonical workspace path에 결합되고 신뢰 상태가 유지될 때만 평가됩니다. 파일 규칙은 한 규칙이 요청의 모든 파일·작업을 포함하고 파일 수·변경 줄·diff byte 한도를 만족해야 합니다. 명령 규칙은 workspace 밖의 canonical absolute executable, token 단위 argv prefix, cwd prefix, timeout과 host network 허용을 모두 만족해야 합니다. Goal 전용 범위도 선택할 수 있습니다. 정책 불일치에는 부분 자동 적용을 하지 않고 exact approval로 전환하며, workspace identity나 trust 경계가 깨지면 거부합니다. MCP 작업은 이 정책의 대상이 아닙니다.

설정의 `파일 생성·수정 자동 승인`은 별도 우회 권한이 아니라 `all-act-runs`, 워크스페이스 루트, `create`·`update`만 포함하는 기존 bounded 정책의 간편 preset입니다. `update`에는 exact patch가 포함되며 `delete`는 preset에 포함되지 않아 계속 직접 승인합니다.

수동 승인 ticket에는 opaque `approvalId`, run id, 만료 시각과 실행 내용에서 계산한 `actionHash`가 포함됩니다. 사용자의 승인 동작은 다음 조건을 모두 만족할 때만 유효합니다.

- 승인 요청을 만든 동일 run의 소유 renderer frame일 것
- 아직 대기 중인 일회성 `approvalId`일 것
- 만료·취소되지 않았을 것
- UI에 표시된 exact action과 hash가 실행 대상과 일치할 것

`actionHash`는 승인 그 자체가 아닙니다. 내용 주소 역할만 하며, 활성 ticket 없이 hash만 재전송해서 실행할 수 없습니다. ticket은 한 번 resolution된 후 재사용할 수 없습니다. run 취소 시 그 run의 모든 승인도 취소됩니다.

### 파일 변경

파일 update/delete는 전체 파일을 읽을 때 얻은 `baseSha256`가 필요합니다. create는 base가 없어야 합니다. 서비스는 정규화한 제안으로 deterministic diff와 `actionHash`를 만들고, 승인 후 적용 직전에 다음을 다시 확인합니다.

- 경로가 workspace 안인지, symlink가 아닌지
- 대상이 허용된 UTF-8 regular file인지
- 현재 preimage hash와 mode가 준비 시점과 같은지
- 승인받은 prepared action이 메모리의 exact action과 같은지

create 대상이 이미 존재하거나 update/patch의 preimage가 달라지면 mutation 오류는 충돌 코드, 대상 경로, 현재 hash를 구조화해 도구 결과로 반환합니다. Agent는 해당 경로의 정확한 `read_file`이 성공할 때까지 후속 내장 파일 변경을 거부하며, 새 preimage를 기준으로 변경안을 다시 만들게 합니다. 디렉터리 목록 조회만으로는 이 refresh 조건을 충족하지 않습니다.

서비스는 첫 파일을 변경하기 전에 각 before/after hash, 이전 내용과 mode를 private write-ahead pending journal에 기록하고 동기화합니다. 각 파일은 같은 디렉터리의 임시 파일과 atomic rename을 사용합니다. 실행 중 하나라도 실패하면 설치된 postimage를 다시 확인한 뒤 이미 적용된 파일을 롤백하고, 성공하면 pending journal을 일반 undo journal로 전환합니다. undo도 첫 파일을 복원하기 전에 `undo-pending` marker를 동기화합니다. 이후 누군가 파일을 바꿨거나 롤백이 완결되지 않으면 marker를 남기고 자동 덮어쓰기를 거부합니다.

여기서 원자성은 **파일별 교체**에 대한 보장입니다. 다중 파일 전체는 하나의 파일시스템 트랜잭션이 아니므로 프로세스가 파일 사이에서 종료되면 잠시 혼합 상태일 수 있습니다. 앱은 시작할 때 pending journal을 찾아 before-image로 복원합니다. 대상이 journal에 기록된 before/after 중 어느 상태도 아니면 concurrent 변경을 덮어쓰지 않고 복구를 중단합니다.

### Git 검사

Git 실행 파일은 현재 workspace 밖의 canonical absolute path로 해석해 PATH shadowing을 차단합니다. repository가 설정한 clean/process filter와 external diff driver는 실행하지 않고, submodule 검사·lazy fetch·Git protocol도 비활성화합니다. status는 민감 경로를 결과에서 제외하고 diff는 안전한 변경 pathspec만 조회합니다. 일반 파일의 patch에서도 credential로 보이는 내용이 발견되면 전체 결과를 provider에 보내지 않고 실패로 닫습니다.

같은 모델 응답의 도구 호출은 표시된 순서대로 처리하며, 모든 run의 write/process/MCP 동작은 공용 side-effect queue를 통과합니다. workspace 전환, trust 변경, 대화 삭제·보관, undo는 새 run을 잠시 막고 기존 run이 종료된 뒤 실행합니다.

## 실행 완료 계약

도구가 활성화된 interactive `act` run이 text-only로 종료하려 하면 main process는 일반 파일 내용과 도구 출력을 제외한 사용자 대화로 구조화된 완료 계약을 분류합니다. 계약은 `response` 또는 `action`과 함께 필요한 효과 종류(`workspace-change`, `process`, `mcp`)를 명시합니다.

- 필요한 효과가 아직 시도되지 않았다면 provider에 `tool_choice: required`를 적용합니다.
- 다른 종류의 성공한 도구는 계약을 충족하지 않습니다.
- 파일 변경의 `applied`, 명령의 `executed`, MCP의 `isError`를 host receipt로 판정합니다.
- 승인 거절·도구 실패는 적용 성공이 아니며, 같은 승인을 무한 반복하지 않고 구체적 blocker를 보고하도록 전환합니다.
- promise, 반복 설계, 이미 받은 허락의 재확인, 증거 없는 완료 주장은 사용자에게 표시하거나 저장하기 전에 폐기합니다.
- 완료 계약 분류에는 선택 파일 내용과 도구 결과를 넣지 않아 저장소 prompt injection이 실행 필요 여부를 낮추지 못하게 합니다.

공급자가 필수 구조화 호출을 지키지 않으면 run은 성공으로 타협하지 않고 오류로 종료합니다. 위반 응답의 usage가 제공된 경우 실패 run에도 소비량을 기록합니다.

Responses 호환 공급자가 활성 도구 호출을 assistant 텍스트로 반환하는 경우에는 화면에 스트리밍하기 전에 전체 응답을 검사합니다. 판별은 고정된 안내 문구가 아니라 run에 등록된 도구 이름·구조적 envelope와 현재 사용자 요청에서 완료된 구조화 호출의 canonical arguments 서명을 사용합니다. 완전하고 균형이 맞는 호출은 synthetic canonical function call로 세션에 연결하고, 불완전한 호출은 한 번만 복구를 요청합니다. 프로토콜 텍스트는 renderer와 대화 DB에 전달하지 않습니다. 복구 응답이 이미 성공한 동일 호출을 반복하면 해당 호출을 실행하지 않고 run을 실패로 닫지만, 실패로 기록된 호출은 구조화된 재시도를 허용합니다. fenced·inline·들여쓰기 코드 예시와 등록되지 않은 도구 표현은 검사 대상에서 제외합니다.

기존 UTF-8 파일의 부분 수정은 `propose_file_patches`가 complete-file payload 대신 hash-bound exact replacement를 사용합니다. 모든 hunk는 같은 원본에서 유일하게 일치해야 하고 서로 겹칠 수 없습니다. Host가 최종 내용을 계산한 뒤 기존 mutation prepare, approval preview, action hash, apply-time preimage 검사, journal, rollback과 undo 경계를 그대로 사용합니다. 생성·삭제·안전하게 patch할 수 없는 전체 교체는 `propose_file_changes`를 사용합니다.

### 구조화 명령

명령 UI는 정확한 argv 배열, cwd, timeout 요약, action hash와 `network: host`를 보여줘야 합니다. 실행기는 shell 문자열을 해석하지 않고 `spawn(executable, args, { shell: false })`를 사용합니다. credential과 process loader 관련 환경 변수를 상속하지 않고 run별 임시 HOME을 사용하며, 출력·실행 시간·인수 크기를 제한합니다.

이것은 **OS sandbox가 아닙니다**. 프로세스가 shell을 거치지 않는다는 사실은 파일 시스템 권한이나 네트워크 권한을 제거하지 않습니다. 승인한 실행 파일은 현재 사용자 권한과 호스트 네트워크를 사용할 수 있습니다. 저장소가 적대적일 수 있거나 명령의 영향 범위를 확신할 수 없다면 승인하지 말고 컨테이너/VM/OS sandbox에서 실행하세요.

## macOS 로컬 credential broker 경계

개발 실행과 외부 CSC identity로 만든 macOS package는 Electron `safeStorage`를 credential backend로 사용합니다. 배포용 외부 identity에는 Apple Team signing을 권장합니다. 프로젝트가 관리하는 self-signed identity로 만든 로컬 macOS package는 outer Electron app을 다시 빌드할 때마다 달라지는 CDHash가 Keychain 승인을 반복시키지 않도록, 별도로 한 번 서명해 byte-for-byte 복사하는 native credential broker를 사용합니다.

broker는 Keychain에 접근하거나 stdin request를 해석하기 전에 다음을 확인합니다.

- 자신이 기대한 `.app` bundle 내부에 있는지와 bundle identifier
- direct parent PID의 실행 파일이 그 bundle의 정확한 main executable인지
- 전체 app bundle의 strict nested-code signature와 현재 outer executable의 exact CDHash
- broker와 parent의 leaf signing certificate가 같은지

요청은 크기가 제한된 versioned binary frame으로만 전달하고 shell, inherited environment, credential argv를 사용하지 않습니다. broker는 provider ID, canonical base URL과 provider generation을 associated data로 결합한 AES-GCM envelope를 만들며, broker rotation마다 새 key ID와 Keychain service/account를 사용합니다. ciphertext marker, signed application metadata와 broker identity probe의 key ID가 모두 일치해야 복호화를 시도합니다. master key는 로그인 Keychain에 두고, Keychain query에는 인증 UI 금지를 지정해 broker가 새 prompt를 임의로 띄우지 않고 실패하도록 합니다. packaging과 runtime은 broker source digest, executable SHA-256, identifier, certificate, CDHash, architecture와 key ID가 setup 및 signed metadata와 다르면 실패합니다.

이 경계의 목적은 저장된 key의 평문 fallback을 막고 정상적인 outer app 재빌드 사이에서 broker identity를 안정화하는 것입니다. 다음을 보장하는 완전한 로컬 보안 경계는 아닙니다.

- self-signed certificate와 broker artifact는 현재 OS 사용자가 소유하는 로컬 개발 자산입니다.
- Electron main, broker와 사용자가 승인한 process는 같은 OS 사용자 권한으로 실행되며 App Sandbox로 서로 격리되지 않습니다.
- broker와 parent의 leaf certificate 일치는 package 무결성 검사에 쓰이는 evidence이지 별도 principal의 authorization 증명이 아닙니다. 특히 로컬 self-signed signing key를 같은 사용자 환경에서 관리하므로 workspace subprocess에 대한 강한 신뢰 경계로 간주하지 않습니다.
- 같은 사용자 권한을 이미 획득한 악성 process, debugger, process memory 관찰, 사용자 Keychain·Application Support 변조까지 broker 하나로 차단한다고 가정할 수 없습니다.
- Workspace Trust는 repository 자동화 표면을 켜는 결정일 뿐 broker나 승인한 process를 별도 principal로 격리하지 않습니다.

더 강한 경계가 필요하면 Apple Team identity와 Hardened Runtime, App Sandbox 적용 가능성 및 notarization을 검토하고, credential을 전용 OS 계정·별도 Keychain·격리된 signer/credential service 또는 VM에 두세요. App Sandbox를 적용할 때는 workspace 접근, child process와 개발 도구 실행 요구를 entitlement 설계와 함께 평가해야 하며, 이름만 활성화해 완전한 격리라고 표현해서는 안 됩니다.

## Prompt injection에 대한 경계

Prompt injection은 자연어 지시만으로 완전히 해결할 수 없습니다. 이 앱의 방어는 모델의 판단과 별개로 다음을 코드에서 강제하는 데 초점을 둡니다.

- 신뢰 전에는 repository-owned instruction/command/skill/tool을 모델에 주지 않음
- 일반 파일과 도구 결과를 untrusted data로 취급
- 활성화되지 않은 도구는 모델 schema 목록에서도 제외
- tool arguments를 host가 재검증
- write/process/MCP call은 모델 단독으로 승인할 수 없으며, 자동 승인은 사용자가 미리 저장한 bounded 정책만 평가
- approval, revision, preimage가 바뀌면 fail closed

모델 답변이 “적용했다” 또는 “격리돼 있다”고 말해도 실제 성공 이벤트와 실행 metadata가 없으면 사실로 취급하지 않아야 합니다.

## 남는 위험

- 같은 OS 사용자 권한의 악성 로컬 프로세스는 앱이 검사하는 사이 파일 시스템을 경쟁적으로 바꿀 수 있습니다.
- 승인한 프로세스와 MCP server는 host 권한과 네트워크를 사용할 수 있습니다.
- 로컬 self-signed credential broker는 outer app 재빌드의 Keychain identity churn을 줄이지만 same-user process isolation이나 Apple이 발급한 배포 신뢰를 제공하지 않습니다.
- 공급자에게 전송한 데이터는 해당 공급자의 보안·보관 정책을 따릅니다.
- 화면 캡처, clipboard, OS swap/backup, crash dump 같은 운영체제 수준 유출은 앱 단독으로 제거할 수 없습니다.
- macOS package는 안정 identity로 서명하지만, 로컬 self-signed 개발 서명에는 Apple Developer ID, notarization, Hardened Runtime/App Sandbox 배포 정책이 포함되지 않습니다. Windows code signing도 별도입니다.

강한 적대 환경에는 별도의 OS 계정, 컨테이너, VM, 네트워크 정책을 함께 사용하세요.
