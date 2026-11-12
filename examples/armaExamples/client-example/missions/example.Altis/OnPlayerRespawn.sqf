params ["_newUnit", "_oldUnit", "_respawn", "_respawnDelay"];
diag_log format ["[ExampleMission] OnPlayerRespawn: %1 respawned", name _newUnit];
systemChat format ["OnPlayerRespawn.sqf ran for %1", name _newUnit];
