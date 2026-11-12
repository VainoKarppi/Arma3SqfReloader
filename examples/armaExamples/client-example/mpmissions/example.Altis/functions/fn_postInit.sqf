if (!isServer) exitWith {};
diag_log "[ExampleMission] CfgFunctions postInit ran (MP server)";
missionNamespace setVariable ["ExampleMission_postInitRan", true];

[] spawn {
	while {true} do {
		diag_log "preInitLoopTest";
		sleep 5;
	};
};
