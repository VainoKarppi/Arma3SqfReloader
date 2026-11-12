params [
    ["_requestId", "", [""]],
    ["_code", "", [""]],
    ["_timeout", 3, [0]]
];

private _execution = [_requestId, _code] spawn {
    params ["_requestId", "_code"];
    private _resultText = "nil";
    private _error = "";

    try {
        private _value = call compile _code;
        if !(isNil "_value") then {
            _resultText = str _value;
        };
    } catch {
        _error = if (_exception isEqualType "") then {_exception} else {str _exception};
    };

    "SqfReloader" callExtension ["ApiPublishResult", [_requestId, _resultText, _error]];
};

[_requestId, _execution, _timeout] spawn {
    params ["_requestId", "_execution", "_timeout"];
    uiSleep _timeout;

    if !(scriptDone _execution) then {
        terminate _execution;
        "SqfReloader" callExtension [
            "ApiPublishResult",
            [_requestId, "", format ["SQF execution timed out after %1 seconds.", _timeout]]
        ];
    };
};
