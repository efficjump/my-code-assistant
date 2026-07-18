# 명령과 확장

확장 기능은 동적 발견을 지원하지만, 발견된 콘텐츠가 호스트 권한을 직접 얻지는 않습니다. custom prompt와 Skill은 Workspace Trust를 요구하고, MCP는 config/tool revision 및 별도 승인을 요구합니다.

## 내장 슬래시 명령

내장 명령은 두 종류입니다.

- local command: 대화, 컨텍스트, 모델, 테마처럼 앱 상태를 직접 조작
- prompt workflow: `/review`, `/explain`, `/plan`, `/tests`처럼 현재 저장소를 조사하도록 모델 입력을 구성

Git 상태·diff는 `/git-status`, `/git-diff [path]`, 저장소 Skill은 `/skills`, 대화 복원은 `/history`, 마지막 승인 변경 되돌리기는 `/undo`로 바로 열 수 있습니다.

내장 prompt는 답을 하드코딩하지 않습니다. 목표를 구조화한 뒤 현재 provider, model, workspace tool을 사용해 실행 시점에 답을 만듭니다.

## 사용자 prompt command

신뢰된 워크스페이스의 `*.command.md` 파일은 `/prompts:<name>`으로 발견됩니다. 파일 위치는 저장소 어디든 가능하며 최대 파일 수·크기 제한이 적용됩니다.

```markdown
---
name: audit-endpoint
description: 선택한 endpoint의 계약과 실패 모드를 점검합니다.
argument-hint: '<path> [FOCUS=value]'
---
Inspect $1 and audit its public contract.
Focus: $FOCUS
All input: $ARGUMENTS
```

지원하는 치환은 다음과 같습니다.

| 문법 | 의미 |
| --- | --- |
| `$1` … `$9` | 따옴표 처리가 끝난 위치 인수 |
| `$ARGUMENTS` | 원본 인수 문자열의 trim 결과 |
| `$NAME` | 대문자 `NAME=value` 인수 |
| `$$` | 리터럴 `$` |

발견 결과는 렌더러가 임의 경로를 전달하지 못하도록 workspace path에서 만든 opaque ID를 사용합니다. descriptor에는 전체 파일 내용의 SHA-256 revision이 들어갑니다. 확장 직전에 다시 발견한 revision이 다르면 명령을 거부하며, 사용자는 목록을 새로고침하고 변경 내용을 다시 확인해야 합니다.

사용자 command는 prompt를 만들 뿐 shell이나 파일 쓰기를 직접 실행하지 않습니다. 확장된 prompt가 요청하는 write/process도 일반 agent approval 정책을 그대로 거칩니다.

## 저장소 Skills

Skill 디렉터리 형식은 다음과 같습니다.

```text
.agents/skills/
  api-review/
    SKILL.md
    scripts/
    references/
    assets/
```

`SKILL.md`에는 유효한 frontmatter와 본문이 필요합니다.

```markdown
---
name: api-review
description: 저장소의 API 계약을 일관된 절차로 검토합니다.
---

# API review workflow

1. Read the route and schema.
2. Compare error contracts.
3. Report evidence with paths.
```

`name`은 소문자 영숫자와 단일 하이픈 구분을 사용합니다. 목록 조회는 name, description, 경로, content hash, 안전하게 발견한 resource path만 반환합니다. 전체 Skill 본문은 사용하기로 결정한 뒤 revision을 함께 넘겨 읽습니다. resource도 descriptor에 열거된 path만 별도로 읽을 수 있습니다. 이를 점진적 공개(progressive disclosure)라고 합니다.

Skill은 코드를 우회 실행하는 권한이 아닙니다. script가 포함돼 있어도 명령 실행 도구를 통해 exact approval을 받아야 합니다. Skill 내용 역시 사용자 의도와 호스트 보안 정책을 덮어쓸 수 없습니다.

## MCP stdio 확장

MCP 서비스 계층은 version 1 JSON config, stdio JSON-RPC server discovery, tool revision, bounded message/schema/result, cancel/timeout, process cleanup을 제공합니다. 전송 방식은 현재 stdio만 지원합니다.

사용자 config 기본 위치는 Electron `userData` 아래 `mcp.json`, 저장소 config 이름은 `.mcp.json`입니다.

```json
{
  "version": 1,
  "servers": [
    {
      "id": "example",
      "name": "Example tools",
      "enabled": false,
      "command": "/absolute/path/to/server",
      "args": ["--stdio"],
      "env": {
        "EXAMPLE_MODE": "local"
      }
    }
  ]
}
```

`enabled` 기본값은 false입니다. user config의 상대 cwd는 허용하지 않습니다. workspace `.mcp.json`은 현재 워크스페이스 안의 cwd만 사용할 수 있으며 다음 두 경계를 모두 통과해야 server를 시작합니다.

1. Workspace Trust가 true일 것
2. config revision과 enabled server 목록에서 계산한 exact action hash를 사용자가 승인할 것

발견된 모든 MCP tool은 server annotation과 관계없이 보수적으로 `process`, `write`, `network` capability 및 `approval-required` risk를 가집니다. `readOnlyHint` 같은 server annotation은 표시용 untrusted hint이며 host policy를 낮추지 않습니다. 각 호출은 server ID, 원래 tool name, tool revision, exact arguments의 action hash에 다시 승인받아야 합니다.

server process에는 최소 환경과 별도 HOME/tmp를 사용하고, protocol/tool/schema/result 크기와 pending request 수를 제한합니다. 그렇더라도 MCP server는 OS sandbox 안에서 실행되는 것이 아니며 host network를 사용할 수 있습니다.

승인된 config revision에서 발견한 도구는 Agent `ToolRegistry`에 `origin: mcp`, `approval-required`로 동적 등록됩니다. 모델에는 현재 run의 신뢰된 workspace와 같은 config revision에 허용된 도구만 노출됩니다. 호출은 ToolRegistry의 strict argument 검증·dispatch를 거친 뒤 `McpService`에서 tool revision과 exact arguments를 다시 확인하고 호출별 승인을 요청합니다. 마지막 활성 run이 끝나거나 trust/workspace가 바뀌면 등록과 server process를 정리합니다.

## 새 확장을 추가할 때

1. 동적으로 발견하되 descriptor에 origin과 revision을 포함합니다.
2. strict JSON schema와 별도의 runtime validator를 작성합니다.
3. capability와 risk를 명시하고 기본값은 더 보수적으로 선택합니다.
4. 현재 trust/run context에서 활성화된 definition만 모델에 제공합니다.
5. 외부 상태 변경은 exact action preview와 일회성 승인 뒤에 실행합니다.
6. 취소, timeout, 출력/결과 크기, cleanup을 테스트합니다.
7. 모델 설명이 아니라 서비스 결과 event를 성공의 근거로 사용합니다.
