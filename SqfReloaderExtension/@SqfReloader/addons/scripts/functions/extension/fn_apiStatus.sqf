// SqfReloader_fnc_apiStatus
// Returns a HashMap describing the current API state.
// [] call SqfReloader_fnc_apiStatus

private _status = createHashMap;

_status set ["ready", SqfReloader_var_ready];
_status set ["version", SqfReloader_var_version];
_status set ["running", SqfReloader_var_apiRunning];
_status set ["url", ""];
_status set ["port", 0];

if (SqfReloader_var_ready) then {
    private _data = ["ApiUrl", []] call SqfReloader_fnc_call;
    if (!isNil "_data") then {_status set ["url", _data param [0, ""]]};

    private _port = ["ApiPort", []] call SqfReloader_fnc_call;
    if (!isNil "_port") then {
        private _value = _port param [0, 0];
        _status set ["port", if (_value isEqualType 0) then {_value} else {parseNumber _value}];
    };

    private _running = ["ApiIsRunning", []] call SqfReloader_fnc_call;
    if (!isNil "_running") then {_status set ["running", _running param [0, false]]};
};

_status
