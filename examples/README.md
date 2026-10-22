# PowerShell API examples

These scripts call the local SqfReloader REST API. Start Arma with `@SqfReloader` first. The
default API base URL is `http://127.0.0.1:8764/api`; pass `-ApiBaseUrl` if your server is on a
different port.

```powershell
.\Get-ArmaStatus.ps1
.\Get-ArmaFunctions.ps1
.\Invoke-ArmaSqf.ps1 -Code '1 + 1' -TimeoutSeconds 30
.\Reload-ArmaFunctions.ps1 -FunctionName example_fnc_add
.\Reload-ArmaFunctions.ps1 # reload all functions
```

To receive an event in Arma, register a handler from SQF first:

```sqf
["PowerShellMessage"] call SqfReloader_fnc_send;
missionNamespace setVariable ["SqfReloader_var_handler_PowerShellMessage", {
    params ["_data"];
    diag_log format ["[PowerShell event] %1", _data];
}];
```

Then send the event and its data:

```powershell
.\Send-ArmaEvent.ps1 -Function PowerShellMessage -Data @("hello", 42)
```

`Invoke-ArmaSqf.ps1` uses `/api/execute`, waits for Arma to return the actual SQF value through
the API, and stops after `-TimeoutSeconds`. `Send-ArmaEvent.ps1` is an event notification and
only confirms that the event was queued; it does not wait for the handler's return value.
