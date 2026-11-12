if (!hasInterface) exitWith {};
diag_log "[ExampleMission] CfgFunctions postInit ran (SP client)";
missionNamespace setVariable ["ExampleMission_postInitRan", true];

[] spawn {
	while {true} do {
		diag_log "preInitLoopTest";
		sleep 5;
	};
};
