# 데이터와 개인정보

## 로컬 저장 데이터

앱은 Electron의 `app.getPath('userData')`가 가리키는 플랫폼별 디렉터리를 기본 저장소로 사용합니다. 절대 경로는 운영체제와 패키지 ID에 따라 달라지므로 코드나 문서에 고정하지 않습니다.

| 데이터 | 기본 파일/영역 | 포함 내용 | 보호 방식 |
| --- | --- | --- | --- |
| 앱 설정 | `settings.json` | provider 이름/URL, 선택 model/theme, 표시 locale, 작업 실행 제한시간, 마지막 workspace와 승인 정책 | versioned JSON, atomic replace, owner-only 권한 시도 |
| 공급자 API 키 | `settings.json` 내부 versioned ciphertext | 일반 환경의 Electron `safeStorage` 결과 또는 로컬 self-signed macOS package의 `credential-broker:mac:v1:<key-id>:` AES-GCM envelope | broker envelope은 provider ID·base URL·generation을 AAD로 결합, key ID 불일치 거부, 안전한 backend가 없으면 저장 거부, 평문 fallback 없음 |
| macOS broker master key | 사용자의 로그인 Keychain generic-password 항목 | 로컬 self-signed package의 broker key ID별 무작위 AES-256 master key | 고정 서명 broker가 만든 Keychain ACL, 인증 UI를 띄우지 않고 실패하도록 요청 |
| macOS 로컬 signing 설정과 broker artifact | 사용자 `~/Library/Application Support` 아래 프로젝트별 private 경로 | 인증서 fingerprint·Keychain 경로·broker key ID·source/artifact digest·CDHash와 pre-signed executable | 저장소 밖 owner-only 파일, config `0600`, private key나 provider credential 미포함 |
| Workspace Trust | `workspace-trust.json` | canonical path, fingerprint, 결정, 시간 | versioned JSON, atomic replace, owner-only 권한 시도 |
| 대화 | `conversations.sqlite3`와 SQLite WAL 파일 | display/model message, context path, tool activity, run 상태 | local SQLite, foreign key, WAL, transaction |
| 감사 이벤트 | 대화 DB | run/action 종류와 제한된 metadata | secret redaction, raw diff/output/content key 생략 |
| MCP user config | `mcp.json` | server command/args/cwd/명시적 env | versioned JSON, atomic replace, owner-only 권한 시도 |
| MCP runtime | `mcp-runtime/` | server별 HOME/tmp | caller 환경과 분리, process 종료 후 관리 |
| 변경 write-ahead/undo journal | 앱이 지정한 private journal 디렉터리 | 적용 전 text와 mode, before/after hash, apply/undo pending·완료 상태 | owner-only 파일, versioned record, workspace별 분리, 시작 시 pending 복구 |

`MutationService`를 앱 외부에서 별도 구성하며 journal 위치를 주지 않으면 OS temporary directory를 기본값으로 사용합니다. 제품 통합에서는 `userData` 아래의 private directory처럼 수명과 삭제 정책이 분명한 위치를 전달하는 것이 좋습니다.

packaged macOS 앱은 signed application metadata에서 credential backend 종류를 먼저 읽습니다. 외부 CSC identity package는 `safeStorage` metadata를 기록하고, 프로젝트가 관리하는 로컬 self-signed packaging만 broker resource와 architecture·source digest·executable digest·identifier·CDHash·key ID evidence를 함께 기록합니다. SettingsStore는 이 metadata와 실제 broker artifact를 검증하고 broker 자체의 identity probe·key ID까지 일치할 때만 backend로 선택합니다. broker metadata나 executable이 누락·변조된 경우 `safeStorage`로 조용히 후퇴하지 않고 fail closed합니다. outer Electron executable의 빌드별 CDHash 대신 byte-for-byte 유지되는 broker가 key ID별 Keychain master key를 사용하며, credential plaintext는 파일이나 argv·환경 변수로 전달하지 않고 bounded stdin/stdout frame으로만 주고받습니다. stderr 내용도 앱 오류에 복제하지 않습니다.

broker package가 시작되면 저장된 legacy Safe Storage credential을 active provider부터 이관합니다. 각 provider는 기존 generation과 ciphertext를 CAS로 다시 확인한 뒤에만 `credential-broker` envelope로 교체하므로 동시에 저장한 새 API key를 덮어쓰지 않습니다. 기존 Safe Storage ciphertext를 처음 여는 과정에는 이전 Keychain 항목에 대한 마지막 사용자 승인이 필요할 수 있습니다. Electron 오류만으로 일시 장애와 사용자 거부를 안정적으로 구분할 수 없으므로 첫 실패에서 자동 순회를 중단해 prompt가 연속으로 뜨지 않게 합니다. 실패한 provider/ciphertext 조합은 같은 process에서 자동 재시도하지 않고 원본 ciphertext와 generation을 유지합니다. 뒤의 provider는 사용자가 명시적으로 접근할 때 lazy migration할 수 있고, 다음 앱 시작에서는 새 snapshot으로 다시 시도할 수 있습니다.

broker를 명시적으로 회전하면 새 key ID, Keychain service/account와 master key namespace를 사용하므로 새 credential은 이전 broker key에 막히지 않고 저장할 수 있습니다. 반대로 settings에 남은 이전 key ID의 broker ciphertext는 새 broker가 복호화하지 않습니다. 회전 전에 기존 credential을 사용할 수 있는 build와 재입력 수단을 확인하고, 회전 뒤에는 필요한 provider key를 다시 저장해야 합니다.

## 대화에 저장되는 것

각 대화에는 다음이 저장될 수 있습니다.

- 사용자에게 보이는 메시지와 공급자에 실제 전송한 model content
- 명시적으로 첨부한 workspace-relative context path
- assistant 응답과 완료/취소/오류/중단 상태
- 도구 이름, 짧은 요약, 시작·완료 상태
- provider/model/workspace 연결 정보
- run과 제한된 audit metadata

감사 metadata sanitizer는 token, secret, password, authorization 같은 key/value를 redaction하고 raw diff, file content, stdout/stderr, tool result로 알려진 필드를 생략합니다. 하지만 **대화 본문 자체는 사용자의 작업 기록**이므로 자동 redaction 대상이 아닙니다. 메시지에 직접 secret을 붙이면 대화 DB와 provider 요청에 포함될 수 있습니다.

## 표시 언어와 원문 보존

`settings.json` version 5는 `ko | en` locale을 저장하며 기본값은 `ko`입니다. 이전 version의 설정은 읽을 때 한국어 locale을 추가해 이관되고, 사용자는 설정 화면에서 한국어와 영어를 변경할 수 있습니다.

locale은 앱 소유 UI와 host가 생성하는 도구 상태·검증·파일/Git/명령/Skill/설정 오류·실행 수명주기·복구 안내의 표시 언어만 결정합니다. 사용자 메시지, 모델 응답, 기존 대화 본문, 파일 내용과 경로, 검색어, command 출력, provider·MCP·Git stderr 오류 원문과 provider·model·MCP 식별자는 번역하거나 덮어쓰지 않습니다. 따라서 host 안내 안에 원문 경로나 오류가 포함되면 한 메시지에 두 언어가 함께 보일 수 있습니다. 이미 저장된 메시지와 도구 기록도 locale 변경을 이유로 다시 작성하지 않습니다.

## 공급자에게 전송될 수 있는 데이터

활성 Responses API 호환 공급자에는 다음이 전송될 수 있습니다.

- 사용자 입력과 이전 완료 대화 history
- 사용자가 첨부한 파일 내용
- 신뢰된 저장소에서 agent가 읽은 파일, 검색 결과, Git 결과
- 신뢰된 저장소의 적용 가능한 instruction/Skill 내용
- 도구 실행 결과의 bounded representation

앱은 요청에 `store: false`를 사용합니다. 이는 앱의 요청 설정이지 공급자 전체의 로그, abuse monitoring, enterprise retention, 네트워크 중계 정책을 보증하지 않습니다. 민감 저장소를 사용하기 전에 공급자 약관과 조직 설정을 확인하세요.

renderer는 provider credential을 받지 않습니다. main process가 필요할 때만 직접 또는 broker child process를 통해 복호화해 SDK에 넘기며 오류 메시지와 감사 metadata에서 알려진 token 패턴을 제거합니다. 이 경계는 renderer 노출과 디스크 평문 저장을 막지만, 같은 OS 사용자 권한에서 실행되는 main·broker·provider client의 process memory를 서로 완전히 격리하는 보장은 아닙니다.

## 삭제와 보관

- 대화 보관은 목록에서 분리하는 논리 상태이며 데이터 삭제가 아닙니다.
- 대화 삭제는 해당 conversation, message, run, audit row를 cascade 삭제합니다.
- SQLite의 일반 row 삭제는 secure erase를 보장하지 않습니다. WAL, backup, filesystem snapshot에 이전 page가 남을 수 있습니다.
- API 키 제거는 현재 settings에서 ciphertext를 제거합니다. OS backup에 있던 이전 settings, Electron Safe Storage 항목 또는 broker master-key 항목까지 지우지는 않습니다.
- Workspace Trust를 해제하면 자동 기능은 비활성화되지만 기존 대화와 journal은 삭제되지 않습니다.
- 마지막 변경 undo는 파일을 복원하고 journal 상태를 갱신하지만 별도 backup/snapshot을 삭제하지 않습니다.
- 비정상 종료 중 남은 apply pending journal은 다음 시작 시 before-image 복구에 사용되며, undo pending은 before-image로 수렴한 뒤 undone으로 확정됩니다. 알려지지 않은 현재 파일 상태는 자동으로 덮어쓰지 않습니다.

완전한 로컬 초기화가 필요하면 앱을 종료하고 운영체제 backup 정책을 확인한 뒤 해당 앱의 `userData` 디렉터리와 별도 지정한 mutation journal을 삭제하세요. macOS에서는 이 작업만으로 로그인 Keychain의 Safe Storage/broker master key나 저장소 밖 로컬 signing config·broker artifact가 삭제되지 않습니다. 그 signing 상태는 다른 ciphertext나 build 검증에도 사용될 수 있으므로 삭제·회전 전에 credential 재입력과 복구 가능성을 별도로 확인해야 합니다. 이러한 작업은 모든 provider 설정, 키, trust, 대화를 되돌릴 수 없이 제거할 수 있어 앱에서 자동으로 수행하지 않습니다.

## 로그와 telemetry

현재 코드에는 별도 analytics/telemetry SDK가 없습니다. 개발 중 console, Electron crash reporter 설정, 운영체제 crash dump, proxy/provider server log는 별도 경로로 정보를 남길 수 있으므로 배포 환경에서 따로 검토해야 합니다.

## 개인정보 체크리스트

- 필요한 파일만 명시적 context로 첨부합니다.
- `.env`, credential, key material을 prompt에 붙이지 않습니다.
- 신뢰 전에 `AGENTS.md`, custom command, Skill, `.mcp.json`을 검토합니다.
- 파일 diff와 정확한 command argv/cwd/network 표시를 승인 전에 확인합니다.
- 민감 작업은 조직이 승인한 provider와 격리 환경에서 실행합니다.
- 공유 장비에서는 작업 후 conversation, settings, trust, journal의 보존 필요성을 확인합니다.
- 로컬 self-signed macOS broker를 same-user 악성 process에 대한 sandbox로 간주하지 않습니다. 더 강한 격리는 Apple Team signing과 Hardened Runtime/App Sandbox의 적용 가능성, 전용 OS 계정·격리 signer/credential service 또는 VM을 함께 검토합니다.
