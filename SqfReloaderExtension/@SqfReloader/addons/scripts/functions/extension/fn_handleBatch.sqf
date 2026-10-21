// SqfReloader_fnc_handleBatch
// Unpacks a coalesced batch of messages: [[function, data], [function, data], ...]
// Messages are handled in order and synchronously so later work sees earlier results.

params [["_batch", "[]", ["", []]]];

private _messages = if (_batch isEqualType "") then {parseSimpleArray _batch} else {_batch};

// Some Arma callback versions wrap the batch payload once more in an array.
while {
    _messages isEqualType []
    && {count _messages == 1}
    && {(_messages select 0) isEqualType []}
    && {count (_messages select 0) > 0}
    && {((_messages select 0) select 0) isEqualType []}
} do {
    _messages = _messages select 0;
};

{
    if !(_x isEqualType [] && {count _x >= 2}) then {continue};
    private _function = _x select 0;
    private _data = _x select 1;
    if (_function isEqualType []) then {_function = _function param [0, ""]};
    if !(_function isEqualType "") then {continue};
    [_function, _data] call SqfReloader_fnc_handleCallback;
} forEach _messages;
