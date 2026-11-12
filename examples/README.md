# SqfReloader API

## PowerShell API examples
These scripts call the local SqfReloader REST API. Start Arma with `@SqfReloader` first. The
default API base URL is `http://127.0.0.1:8764/api`; pass `-ApiBaseUrl` if your server is on a
different port.

```powershell
.\Get-ArmaStatus.ps1
.\Get-ArmaFunctions.ps1
.\Invoke-ArmaSqf.ps1 -Code '1 + 1' -TimeoutSeconds 30
.\Send-ArmaSqf.ps1 -Code 'systemChat "Hello from PowerShell";'
.\Reload-ArmaFunctions.ps1 -FunctionName example_fnc_add
.\Reload-ArmaFunctions.ps1 # reload all functions
```

To receive an event in Arma, register a handler from SQF first:

```sqf
["PowerShellMessage"] call SqfReloader_fnc_send; // Register event

// On event received
missionNamespace setVariable ["SqfReloader_var_handler_PowerShellMessage", {
    params ["_data"];
    diag_log format ["[PowerShell event] %1", _data];
}];
```

Then send the event and its data:

```powershell
.\Send-ArmaEvent.ps1 -Function PowerShellMessage -Data @("hello", 42)
```

`Invoke-ArmaSqf.ps1` uses `/api/eval`, waits for Arma to return the SQF value through the API,
and stops after `-TimeoutSeconds`. `Send-ArmaSqf.ps1` uses `/api/execute` for fire-and-forget
code: it returns when Arma accepts the request and does not wait for the SQF result.
`Send-ArmaEvent.ps1` likewise confirms only that the event was queued.


## Endpoints

| Method | Route | Body |
| --- | --- | --- |
| POST | `/api/command` | `{"type":"code"\|"recompile","code":"...","method":"..."}` (EdenOnline compatible) |
| POST | `/api/send` | `{"function":"MyEvent","data":[...]}` - calls the SQF handler registered for `MyEvent` |
| POST | `/api/eval` | `{"code":"systemChat 'hi'"}` - runs code inside Arma |
| POST | `/api/reload` | `{"functions":["MyTag_fnc_one"]}` or `{}` - recompiles `fn_*.sqf` from disk |
| POST | `/api/source` | `{"directory":"...\\@SqfReloader\\source"}` - points the DLL at the SQF sources |
| POST | `/api/log` | `{"level":"debug"}` |
| GET | `/api` | documentation page in a browser, status JSON otherwise |
| GET | `/api/docs` | documentation page |
| GET | `/api/status` | - |
| GET | `/api/functions` | - |

Default endpoint: `http://127.0.0.1:8764/api/` (config: `%LOCALAPPDATA%\SqfReloader\config.json`).
Opening that URL in a browser shows the generated API documentation; scripts that do not send an
HTML `Accept` header keep receiving the status JSON.

## Quick start

### Checking API Status
```powershell
curl.exe -s http://127.0.0.1:8764/api/status
curl.exe -s -X POST http://127.0.0.1:8764/api/eval -H "Content-Type: application/json" -d "{\"code\":\"systemChat 'from REST'\"}"
```

### Reloading other mods' functions

```powershell
curl.exe -s -X POST http://127.0.0.1:8764/api/reload -H "Content-Type: application/json" -d "{\"functions\":[\"MyTag_fnc_one\"]}"
```

### Sending data into the game

```powershell
curl.exe -s -X POST http://127.0.0.1:8764/api/send -H "Content-Type: application/json" -d "{\"function\":\"MyEvent\",\"data\":[1,\"two\",[3,4],true,nil]}"
```
