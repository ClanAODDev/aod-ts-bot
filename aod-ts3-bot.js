#!/bin/node --experimental-json-modules

/**
 * ClanAOD.net TS3 integration bot
 * 
 * Author: Adam Schultz <archangel122184@gmail.com>
 */

/* jshint esversion: 8 */

const { TeamSpeak } = require("ts3-nodejs-library");

const sprintf = require('sprintf-js').sprintf;
//const vsprintf = require('sprintf-js').vsprintf;

//include config
var config = require('./aod-ts3-bot.config.json');

//inclue fs
const fs = require('fs');

//include md5
var md5 = require('md5');

//include AOD group config
var forumIntegrationConfig;
try {
	forumIntegrationConfig = require(config.forumGroupConfig);
} catch (error) {
	console.log(error);
	forumIntegrationConfig = {};
}

//permission levels
const PERM_OWNER = 8;
const PERM_ADMIN = 7;
const PERM_STAFF = 6;
const PERM_DIVISION_COMMANDER = 5;
const PERM_MOD = 4;
const PERM_RECRUITER = 3;
const PERM_MEMBER = 2;
const PERM_GUEST = 1;
const PERM_NONE = 0;

//global undefined for readable code
var undefined;

var startTime = new Date();
var connectTime = null;

var whoami;
const teamspeak = new TeamSpeak({
	host: config.host,
	serverport: config.serverport,
	queryport: config.queryport,
	username: config.username,
	password: config.password,
	nickname: config.nickname,
	protocol: config.protocol
});

/*************************************
	Utility Functions
 *************************************/

Object.defineProperty(global, '__stack', {
	get: function() {
		var orig = Error.prepareStackTrace;
		Error.prepareStackTrace = function(_, stack) {
			return stack;
		};
		var err = new Error();
		Error.captureStackTrace(err, arguments.callee);
		var stack = err.stack;
		Error.prepareStackTrace = orig;
		return stack;
	}
});

Object.defineProperty(global, '__caller_line', {
	get: function() {
		return __stack[2].getLineNumber();
	}
});

Object.defineProperty(global, '__caller_function', {
	get: function() {
		return __stack[2].getFunctionName();
	}
});

function truncateStr(str, maxLen) {
	if (str.length <= maxLen)
		return str;
	return str.substr(0, maxLen - 5) + ' ...';
}

//log and notify of errors processing commands
function notifyRequestError(invoker, error, showError) {
	if (error) {
		console.error(`Error from ${__caller_function}:${__caller_line}: ${error.toString()}`);
		if (showError && invoker) {
			return invoker.message("An error occurred while processing your request\n" + error.toString())
				.catch(console.error);
		}
	}
	var promise = new Promise(function(resolve, reject) {
		reject();
	});
	return promise;
}

//initialize and return the mysql database connection 
var mysql = require('mysql');
var mysqlConnection = null;

function connectToDB() {
	if (mysqlConnection !== null && mysqlConnection.state !== 'disconnected')
		return mysqlConnection;
	mysqlConnection = mysql.createConnection(config.mysql);
	mysqlConnection.connect(error => {
		if (error)
			return notifyRequestError(null, error, false);
	});
	mysqlConnection
		.on('close', error => {
			if (error) {
				notifyRequestError(null, error, false);
				connectToDB();
			}
		})
		.on('error', error => {
			notifyRequestError(null, error, false);
			if (error.code === 'PROTOCOL_CONNECTION_LOST')
				connectToDB();
		});
	return mysqlConnection;
}

//send a reply as DM to the invoker (if available) and return a promise
function sendReplyToInvoker(invoker, data) {
	if (invoker)
		return invoker.message(data);
	var promise = new Promise(function(resolve, reject) {
		reject();
	});
	return promise;
}


/*************************************
	Command Processing Functions
 *************************************/

//forward declaration of commands in case any of the functions need it
var commands;

//params parsing
var paramsRegEx = /([^\s"'\u201C]+)|"(((\\")|([^"]))*)"|'(((\\')|([^']))*)'|\u201C([^\u201D]*)\u201D/g; //BE CAREFUL OF CAPTURE GROUPS BELOW
var paramsReplaceEscapedSingleRegEx = /\\'/g;
var paramsReplaceExcapedDoubleRegEx = /\\"/g;

function getParams(string) {
	paramsRegEx.lastIndex = 0;
	var params = [];
	var match = null;
	do {
		//Each call to exec returns the next regex match as an array
		match = paramsRegEx.exec(string);
		if (match != null) {
			//console.log(match);
			let param;
			if (match[1])
				param = match[1];
			else if (match[2])
				param = match[2].replace(paramsReplaceExcapedDoubleRegEx, '"');
			else if (match[6])
				param = match[6].replace(paramsReplaceEscapedSingleRegEx, "'");
			else if (match[10])
				param = match[10];
			else
				param = match[0];
			params.push(param);
		}
	} while (match != null);
	return params;
}

Array.prototype.includesAtLeastOne = function(itemArray, start) {
	return this.some(function(elem) {
		return itemArray.includes(elem);
	});
};

function getPermissionLevelForMember(serverGroups) {
	if (serverGroups.length <= 0)
		return [PERM_NONE, '<none>'];
	//if (serverGroups.includes(...))
	//	return [PERM_OWNER, "Admin"];
	if (config.adminGroups.includesAtLeastOne(serverGroups))
		return [PERM_ADMIN, 'Admin'];
	else if (config.staffGroups.includesAtLeastOne(serverGroups))
		return [PERM_STAFF, 'Staff'];
	else if (config.divisionCommandGroups.includesAtLeastOne(serverGroups))
		return [PERM_DIVISION_COMMANDER, 'Division Commander'];
	else if (config.modGroups.includesAtLeastOne(serverGroups))
		return [PERM_MOD, 'Moderator'];
	else if (config.recruiterGroups.includesAtLeastOne(serverGroups)) //FIXME Officers
		return [PERM_RECRUITER, 'Recruiter'];
	else if (config.memberGroups.includesAtLeastOne(serverGroups))
		return [PERM_MEMBER, 'Member'];
	else if (config.memberGroups.includesAtLeastOne(serverGroups))
		return [PERM_GUEST, 'Guest'];
	return [PERM_NONE, '<none>'];
}

//help command processing
function commandHelp(invoker, cmd, args, perm, permName) {
	let filter;
	let footer = "\n**Note** : Parameters that require spaces must be 'single' or \"double\" quoted.";
	let detail = (perm == PERM_NONE ? true : false);
	if (args.length) {
		detail = true;
		filter = args.shift();
	}
	let message = "\n";
	if (!detail)
		message += `User Level: **${permName}** Commands (Use !help <cmd> to see the details of each command):\n\n`;

	Object.keys(commands).forEach(cmd => {
		let commandObj = commands[cmd];
		if (commandObj.minPermission <= perm && (!filter || filter === cmd)) {
			let commandArgsText = commandObj.args;
			if (Array.isArray(commandArgsText))
				commandArgsText = commandArgsText.join(" ");

			if (detail) {
				let commandHelpText = commandObj.helpText;
				if (Array.isArray(commandHelpText))
					commandHelpText = commandHelpText.join("\n> ");
				if (commandHelpText !== '')
					message += commandHelpText + "\n";
			} else {
				let line = `${cmd} ${commandArgsText}\n`;
				message += line;
			}
		}
	});

	message += footer;
	invoker.message(message);
}

function commandPing(invoker, cmd, args, perm, permName) {
	invoker.message("\nPong!");
}

function commandReload(invoker, cmd, args, perm, permName) {
	console.log(`Reload config requested by ${invoker.nickname}[${invoker.uniqueIdentifier}]`);
	config = require('./aod-ts-bot.config.json');
	invoker.message("\nConfiguration reloaded");
}

async function commandStatus(invoker, cmd, args, perm, permName) {
	let now = new Date().getTime();
	let upTime = now - startTime.getTime();
	let connectedTime = now - connectTime.getTime();

	let uptimeSeconds = Math.round(upTime / 1000);
	let uptimeMinutes = Math.floor(uptimeSeconds / 60);
	uptimeSeconds -= (uptimeMinutes * 60);
	let uptimeHours = Math.floor(uptimeMinutes / 60);
	uptimeMinutes -= (uptimeHours * 60);
	let uptimeDays = Math.floor(uptimeHours / 24);
	uptimeHours -= (uptimeDays * 24);

	let connectedSeconds = Math.round(connectedTime / 1000);
	let connectedMinutes = Math.floor(connectedSeconds / 60);
	connectedSeconds -= (connectedMinutes * 60);
	let connectedHours = Math.floor(connectedMinutes / 60);
	connectedMinutes -= (connectedHours * 60);
	let connectedDays = Math.floor(connectedHours / 24);
	connectedHours -= (connectedDays * 24);

	invoker.message("\n" +
			`Up Time: ${uptimeDays} days ${uptimeHours} hours ${uptimeMinutes} minutes ${uptimeSeconds} seconds\n` +
			`Connected Time: ${connectedDays} days ${connectedHours} hours ${connectedMinutes} minutes ${connectedSeconds} seconds`)
		.catch(err => { console.error(err); });
}



//get forum groups from forum database
function getForumGroups() {
	var promise = new Promise(function(resolve, reject) {
		let db = connectToDB();
		let query = `SELECT usergroupid AS id,title AS name FROM ${config.mysql.prefix}usergroup`; //WHERE title LIKE "AOD%" OR title LIKE "%Officers"
		db.query(query, function(err, rows, fields) {
			if (err)
				return reject(err);
			else {
				let groupsByID = {};
				for (var i in rows) {
					groupsByID[rows[i].id] = rows[i].name;
				}
				return resolve(groupsByID);
			}
		});
	});
	return promise;
}

//get forum users from forum groups
function getForumUsersForGroups(groups, allowPending) {
	var promise = new Promise(function(resolve, reject) {
		let usersByTSID = {};
		let db = connectToDB();
		let groupStr = groups.join(',');
		let groupRegex = groups.join('|');
		let query =
			`SELECT u.userid,u.username,f.field18,f.field13, ` +
			`(CASE WHEN (r.requester_id IS NOT NULL AND r.approver_id IS NULL) THEN 1 ELSE 0 END) AS pending ` +
			`FROM ${config.mysql.prefix}user AS u ` +
			`INNER JOIN ${config.mysql.prefix}userfield AS f ON u.userid=f.userid ` +
			`LEFT JOIN  ${config.mysql.trackerPrefix}member_requests AS r ON u.userid=r.member_id AND r.approver_id IS NULL ` +
			`WHERE (u.usergroupid IN (${groupStr}) OR u.membergroupids REGEXP '(^|,)(${groupRegex})(,|$)' `;
		if (allowPending === true)
			query +=
			`OR r.requester_id IS NOT NULL `;
		query +=
			`) AND (f.field18 IS NOT NULL AND f.field18 <> '') ` +
			`ORDER BY f.field13,u.username`;
		let queryError = false;
		db.query(query)
			.on('error', function(err) {
				queryError = true;
				reject(err);
			})
			.on('result', function(row) {
				let tsid = row.field18;
				tsid = tsid.trim();
				if (usersByTSID[tsid] !== undefined) {
					console.log(`Found duplicate tsid ${usersByTSID[tsid].tsid} for forum user ${row.username} first seen for forum user ${usersByTSID[tsid].name}`);
				} else {
					usersByTSID[tsid] = {
						name: row.username,
						id: row.userid,
						division: row.field13,
						tsid: tsid,
						pending: row.pending
					};
				}
			})
			.on('end', function(err) {
				if (!queryError)
					resolve(usersByTSID);
			});
	});
	return promise;
}

//get forum group for guild member
function getForumGroupsForUser(invoker) {
	var promise = new Promise(function(resolve, reject) {
		let db = connectToDB();
		let query =
			`SELECT u.userid,u.username,f.field19,f.field20,u.usergroupid,u.membergroupids FROM ${config.mysql.prefix}user AS u ` +
			`INNER JOIN ${config.mysql.prefix}userfield AS f ON u.userid=f.userid ` +
			`WHERE f.field18="${invoker.uniqueIdentifier}"`;
		db.query(query, function(err, rows, fields) {
			if (err)
				reject(err);
			else {
				if (rows === undefined || rows.length === 0) {
					return resolve();
				}
				if (rows.length > 1) { //danger will robinson! name conflict in database
					invoker.message("Hello AOD member! There is a conflict with your TSID. Please verify your profile and contact the leadership for help.").catch(() => {});
					return reject(`Member name conflict: ${rows.length} members have the TSID ${invoker.uniqueIdentifier}`);
				}

				let row = rows.shift();
				let forumGroups = [];
				if (row.usergroupid !== undefined)
					forumGroups.push(`${row.usergroupid}`);
				if (row.membergroupids !== undefined)
					forumGroups = forumGroups.concat(row.membergroupids.split(','));
				return resolve({ name: row.username, groups: forumGroups });
			}
		});
	});
	return promise;
}


var TSGroupsByForumGroup = null;

async function getTSGroupsByForumGroup(doUpdate) {
	if (!doUpdate && TSGroupsByForumGroup !== null)
		return TSGroupsByForumGroup;

	TSGroupsByForumGroup = {};

	for (const groupName of Object.keys(forumIntegrationConfig)) {
		var groupMap = forumIntegrationConfig[groupName];
		if (groupMap.sgid === undefined) {
			notifyRequestError(invoker, `Bad map for ${groupName}`, (perm >= PERM_MOD));
			return;
		}

		for (var i in groupMap.forumGroups) {
			var group = groupMap.forumGroups[i];
			if (TSGroupsByForumGroup[group] === undefined)
				TSGroupsByForumGroup[group] = {};
			if (TSGroupsByForumGroup[group][groupMap.sgid] === undefined) {
				let serverGroup = await teamspeak.getServerGroupById(groupMap.sgid);
				if (serverGroup === undefined || serverGroup === null) {
					notifyRequestError(invoker, `Bad map for ${groupName}`, (perm >= PERM_MOD));
					continue;
				}
				TSGroupsByForumGroup[group][groupMap.sgid] = serverGroup;
			}
		}
	}
	return TSGroupsByForumGroup;
}

function setTSGroupsForInvoker(invoker) {
	getForumGroupsForUser(invoker)
		.then(async function(data) {
			if (data === undefined || data.groups.length === 0) {
				return;
			}

			let TSGroupsByForumGroup = await getTSGroupsByForumGroup();
			let groupsToAdd = [];
			let groupNames = [];
			for (var i in data.groups) {
				var group = data.groups[i];
				if (TSGroupsByForumGroup[group] !== undefined) {
					for (const sgid of Object.keys(TSGroupsByForumGroup[group])) {
						if (!invoker.servergroups.includes(sgid)) {
							if (!groupsToAdd.includes(sgid)) {
								groupsToAdd.push(sgid);
								groupNames.push(TSGroupsByForumGroup[group][sgid].name);
							}
						}
					}
				}
			}
			if (groupsToAdd.length) {
				try {
					await teamspeak.clientAddServerGroup(invoker.databaseId, groupsToAdd);
				} catch (error) {}
				invoker.message(`Hello ${data.name}! The following server groups have been granted: ${groupNames.join(', ')}. Use \`!help\` to see available commands.`).catch(() => {});
			}
		})
		.catch(error => { notifyRequestError(invoker, error, false); });
}

function setTSIDForForumUser(forumUser, uniqueIdentifier) {
	if (forumUser.tsid == uniqueIdentifier)
		return;
	console.log(`Updating TSID for ${forumUser.name} (${forumUser.id}) from '${forumUser.tsid}' to '${uniqueIdentifier}'`);
	let db = connectToDB();
	let query = `UPDATE ${config.mysql.prefix}userfield SET field18="${uniqueIdentifier}" WHERE userid=${forumUser.id}`;
	db.query(query, function(err, rows, fields) {});
}

//do forum sync with TS groups
async function doForumSync(invoker, perm, checkOnly, doDaily) {
	var hrStart = process.hrtime();
	let adds = 0,
		removes = 0,
		misses = 0,
		duplicates = 0;

	let forumGroups;
	try {
		forumGroups = await getForumGroups();
	} catch (error) {
		return notifyRequestError(invoker, error, (perm >= PERM_MOD));
	}

	let date = new Date();
	try {
		fs.writeFileSync(config.syncLogFile, `${date.toISOString()}  Forum sync started\n`, 'utf8');
	} catch (e) {
		console.error(e);
	}

	let serverInfo = await teamspeak.serverInfo();
	try {
		fs.writeFileSync(config.populationLogFile, `${serverInfo.virtualserverClientsonline}/${serverInfo.virtualserverMaxclients}\n`, 'utf8');
	} catch (e) {
		console.error(e);
	}

	let seenByID = {}; //make sure we don't have users added as both guest and member
	for (let groupName in forumIntegrationConfig) {
		if (forumIntegrationConfig.hasOwnProperty(groupName)) {
			let groupMap = forumIntegrationConfig[groupName];
			if (groupMap.sgid === undefined) {
				notifyRequestError(invoker, `Bad map for ${groupName}`, (perm >= PERM_MOD));
				continue;
			}
			let isMemberGroup = config.memberGroups.includes(groupMap.sgid);

			let usersByTSID;
			try {
				usersByTSID = await getForumUsersForGroups(groupMap.forumGroups, isMemberGroup);
			} catch (error) {
				notifyRequestError(invoker, error, (perm >= PERM_MOD));
				continue;
			}

			date = new Date();
			fs.appendFileSync(config.syncLogFile, `${date.toISOString()}  Sync ${groupName}\n`, 'utf8');

			let groupMembers;
			try {
				groupMembers = await teamspeak.serverGroupClientList(groupMap.sgid);
			} catch (error) {
				notifyRequestError(invoker, error, (perm >= PERM_MOD));
				continue;
			}
			if (!groupMembers || groupMembers.length == 0) {
				notifyRequestError(invoker, `Unable to get members from ${groupName}`, (perm >= PERM_MOD));
				continue;
			}

			//for each group member 
			//   track them by tag so we can easily access them again later
			//   if their tags aren't configured on the forums, mark for removal
			let toRemove = [];
			let membersByID = {};
			let duplicateID = [];
			for (const groupMember of groupMembers) {
				membersByID[groupMember.clientUniqueIdentifier] = groupMember;
				let forumUser = usersByTSID[groupMember.clientUniqueIdentifier];

				if (forumUser === undefined) {
					removes++;
					toRemove.push(`${groupMember.clientUniqueIdentifier} (${groupMember.clientNickname})`);
					if (!checkOnly) {
						try {
							await teamspeak.serverGroupDelClient(groupMember.cldbid, groupMap.sgid);
						} catch (error) {
							console.error(`Failed to remove ${groupName} from ${groupMember.clientUniqueIdentifier}`);
							notifyRequestError(invoker, error, (perm >= PERM_MOD));
						}
					}
				} else {
					if (isMemberGroup) {
						if (seenByID[forumUser.tsid] !== undefined) {
							duplicateID.push(`${forumUser.tsid} (${forumUser.name}) -- First seen user ${seenByID[forumUser.tsid].name}`);
							duplicates++;
						} else {
							seenByID[forumUser.tsid] = forumUser;
						}
					}
				}
			}

			//for each forum member mapped to the gruop
			//   if we haven't already seen the group member
			//       if there is a user, at them to the group
			//       otherwise, mark them as an error and move on
			let toAdd = [];
			let noAccount = [];
			for (let u in usersByTSID) {
				if (usersByTSID.hasOwnProperty(u)) {
					if (membersByID[u] === undefined) {
						let forumUser = usersByTSID[u];
						let groupMember;

						//don't add members who are pending
						if (forumUser.pending)
							continue;

						try {
							groupMember = await teamspeak.clientDbFind(forumUser.tsid, true);
							if (groupMember && groupMember.length)
								groupMember = groupMember.shift();
						} catch (error) {
							//notifyRequestError(invoker, error, (perm >= PERM_MOD));
						}

						if (groupMember) {
							//clientDbFind is case insensitive, lets grab the clientDbInfo and verify
							let groupMemberInfo;
							try {
								groupMemberInfo = await teamspeak.clientDbInfo(groupMember.cldbid);
								if (groupMemberInfo && groupMemberInfo.length)
									groupMemberInfo = groupMemberInfo.shift();
							} catch (error) {
								console.error(`Failed to get client DB info for ${forumUser.tsid}, dbid:${groupMember.cldbid}: ${error}`);
							}

							if (!groupMemberInfo || groupMemberInfo.clientUniqueIdentifier !== forumUser.tsid) {
								console.log(`Found client db entry for ${forumUser.name}[${forumUser.tsid}] but tsid does not match client info [${groupMemberInfo.clientUniqueIdentifier}]`);
							} else {
								adds++;
								toAdd.push(`${forumUser.tsid} (${forumUser.name})`);
								if (!checkOnly) {
									try {
										await teamspeak.serverGroupAddClient(groupMember.cldbid, groupMap.sgid);
									} catch (error) {
										console.error(`Failed to add ${groupName} to ${forumUser.tsid}: ${error}`);
										notifyRequestError(invoker, error, (perm >= PERM_MOD));
										continue;
									}
								}
							}
						} else {
							misses++;
							noAccount.push(`${u} (${forumUser.name} -- ${forumUser.division})`);
						}
					}
				}
			}

			if (toAdd.length) {
				fs.appendFileSync(config.syncLogFile, `\tMembers to add (${toAdd.length}):\n\t\t`, 'utf8');
				fs.appendFileSync(config.syncLogFile, toAdd.join('\n\t\t') + "\n", 'utf8');
				if (invoker) {
					let message = `Sync ${groupName}: Members to add (${toAdd.length}): ` + truncateStr(toAdd.join(', '), 1024);
					invoker.message(message).catch(() => {});
				}
			}
			if (noAccount.length) {
				fs.appendFileSync(config.syncLogFile, `\tMembers to add with no TeamSpeak client (${noAccount.length}):\n\t\t`, 'utf8');
				fs.appendFileSync(config.syncLogFile, noAccount.join('\n\t\t') + "\n", 'utf8');
				if (invoker) {
					let message = `Sync ${groupName}: Members to add with no TeamSpeak client (${noAccount.length}): ` + truncateStr(noAccount.join(', '), 1024);
					invoker.message(message).catch(() => {});
				}
			}
			if (toRemove.length) {
				fs.appendFileSync(config.syncLogFile, `\tMembers to remove (${toRemove.length}):\n\t\t`, 'utf8');
				fs.appendFileSync(config.syncLogFile, toRemove.join('\n\t\t') + "\n", 'utf8');
				if (invoker) {
					let message = `Sync ${groupName}: Members to remove (${toRemove.length}): ` + truncateStr(toRemove.join(', '), 1024);
					invoker.message(message).catch(() => {});
				}
			}
			if (duplicateID.length) {
				fs.appendFileSync(config.syncLogFile, `\tDuplicate Tags (${duplicateID.length}):\n\t\t`, 'utf8');
				fs.appendFileSync(config.syncLogFile, duplicateID.join('\n\t\t') + "\n", 'utf8');
				if (invoker) {
					let message = `Sync ${groupName}: Duplicate Tags (${duplicateID.length}): ` + truncateStr(duplicateID.join(', '), 1024);
					invoker.message(message).catch(() => {});
				}
			}
		}
	}

	let hrEnd = process.hrtime(hrStart);
	let hrEndS = sprintf('%.3f', (hrEnd[0] + hrEnd[1] / 1000000000));
	let msg = `Forum Sync Processing Time: ${hrEndS}s; ${adds} groups added, ${removes} groups removed, ${misses} members with no TeamSpeak client, ${duplicates} duplicate tags`;
	sendReplyToInvoker(invoker, msg).catch(() => {});
	if (invoker || adds || removes)
		console.log(msg);
	date = new Date();
	fs.appendFileSync(config.syncLogFile, `${date.toISOString()}  ${msg}\n`, 'utf8');
}

//forum sync command processing
async function commandForumSync(invoker, cmd, args, perm, permName) {
	let subCmd = args.shift();
	if (!subCmd)
		return;

	switch (subCmd) {
		case 'showmap': {
			getForumGroups()
				.then(forumGroups => {
					let message = "Configured Group Maps:\n";
					Object.keys(forumIntegrationConfig).forEach(groupName => {
						let groupMap = forumIntegrationConfig[groupName];
						message += groupName + (groupMap.permanent ? ' (permanent):' : ':') + groupMap.forumGroups.map(groupID => `${forumGroups[groupID]} (${groupID})`).join(', ') + "\n";
					});
					sendReplyToInvoker(invoker, message);
				})
				.catch(error => { notifyRequestError(invoker, error, (perm >= PERM_MOD)); });
			break;
		}
		case 'showtsgroups': {
			let message = "TeamSpeak Officer Groups:\n";

			try {
				let tsGroups = await teamspeak.serverGroupList();
				tsGroups.forEach(group => {
					if (group.name.endsWith(config.tsOfficerSuffix)) {
						message += group.name + "\n";
					}
				});
			} catch (error) {
				console.error(`Failed to get server group list`);
				notifyRequestError(invoker, error, (perm >= PERM_MOD));
			}
			sendReplyToInvoker(invoker, message);
			break;
		}
		case 'showforumgroups': {
			getForumGroups()
				.then(forumGroups => {
					let list = Object.keys(forumGroups).map(k => `${forumGroups[k]} (${k})`).sort();
					let message = "AOD Forum Groups:\n";
					message += list.join("\n");
					sendReplyToInvoker(invoker, message);
				})
				.catch(error => { notifyRequestError(invoker, error, (perm >= PERM_MOD)); });
			break;
		}
		case 'check':
			doForumSync(invoker, perm, true);
			break;
		case 'sync':
			doForumSync(invoker, perm, false);
			break;
		case 'add': {
			let tsGroupName = args.shift();
			let groupName = args.shift();

			if (!tsGroupName.endsWith(config.tsOfficerSuffix))
				return sendReplyToInvoker(invoker, 'Only Officer Server Groups may be mapped');
			if (!groupName.endsWith(config.forumOfficerSuffix))
				return sendReplyToInvoker(invoker, 'Only Officer Forum Groups may be mapped');

			let serverGroup;
			try {
				serverGroup = await teamspeak.getServerGroupByName(tsGroupName);
			} catch (error) {
				console.error(`Failed to get server group`);
				notifyRequestError(invoker, error, (perm >= PERM_MOD));
			}
			if (!serverGroup)
				return sendReplyToInvoker(invoker, `${tsGroupName} server group not found`);

			let map = forumIntegrationConfig[tsGroupName];
			if (map && map.permanent)
				return sendReplyToInvoker(invoker, `${tsGroupName} can not be edited`);

			getForumGroups()
				.then(forumGroups => {
					var forumGroupId = parseInt(Object.keys(forumGroups).find(k => {
						if (forumGroups[k] !== groupName)
							return false;
						return true;
					}), 10);
					if (forumGroupId !== undefined && !isNaN(forumGroupId)) {
						//don't use the version from our closure to prevent asynchronous stuff from causing problems
						let map = forumIntegrationConfig[tsGroupName];
						if (map === undefined) {
							forumIntegrationConfig[tsGroupName] = {
								permanent: false,
								forumGroups: [forumGroupId],
								sgid: `serverGroup.sgid`
							};
							fs.writeFileSync(config.forumGroupConfig, JSON.stringify(forumIntegrationConfig), 'utf8');
							getTSGroupsByForumGroup(true);
							return sendReplyToInvoker(invoker, `Mapped group ${groupName} to server group ${tsGroupName}`);
						} else {
							let index = map.forumGroups.indexOf(forumGroupId);
							if (index < 0) {
								map.forumGroups.push(forumGroupId);
								fs.writeFileSync(config.forumGroupConfig, JSON.stringify(forumIntegrationConfig), 'utf8');
								getTSGroupsByForumGroup(true);
								return sendReplyToInvoker(invoker, `Mapped group ${groupName} to server group ${tsGroupName}`);
							} else {
								return sendReplyToInvoker(invoker, 'Map already exists');
							}
						}
					} else {
						return sendReplyToInvoker(invoker, `${groupName} group not found`);
					}
				})
				.catch(error => { notifyRequestError(invoker, error, (perm >= PERM_MOD)); });
			break;
		}
		case 'rem': {
			let tsGroupName = args.shift();
			let groupName = args.shift();

			if (!tsGroupName.endsWith(config.tsOfficerSuffix))
				return sendReplyToInvoker(invoker, 'Only Officer Server Groups may be mapped');
			if (!groupName.endsWith(config.forumOfficerSuffix))
				return sendReplyToInvoker(invoker, 'Only Officer Forum Groups may be mapped');

			let serverGroup;
			try {
				serverGroup = await teamspeak.getServerGroupByName(tsGroupName);
			} catch (error) {
				console.error(`Failed to get server group`);
				notifyRequestError(invoker, error, (perm >= PERM_MOD));
			}
			if (!serverGroup)
				return sendReplyToInvoker(invoker, `${tsGroupName} server group not found`);

			let map = forumIntegrationConfig[tsGroupName];
			if (!map)
				return sendReplyToInvoker(invoker, 'Map does not exist');
			if (map.permanent)
				return sendReplyToInvoker(invoker, `${roleName} can not be edited`);

			getForumGroups()
				.then(forumGroups => {
					var forumGroupId = parseInt(Object.keys(forumGroups).cache.find(k => {
						if (forumGroups[k] !== groupName)
							return false;
						return true;
					}), 10);

					let index = map.forumGroups.indexOf(forumGroupId);
					if (index < 0) {
						return message.reply('Map does not exist');
					} else {
						map.forumGroups.splice(index, 1);
						if (map.forumGroups.length === 0)
							delete forumIntegrationConfig[role.name];
						fs.writeFileSync(config.forumGroupConfig, JSON.stringify(forumIntegrationConfig), 'utf8');
						getTSGroupsByForumGroup(true);
						sendReplyToInvoker(invoker, `Removed map of group ${groupName} to role ${role.name}`);
					}
				})
				.catch(error => { notifyRequestError(invoker, error, (perm >= PERM_MOD)); });
		}
	}
}

//login command processing
var loginErrorsByUniqueID = [];
//async function commandLogin(message, member, cmd, args, guild, perm, permName, isDM) {
async function commandLogin(invoker, cmd, args, perm, permName) {
	if (args.length < 2)
		return sendReplyToInvoker(invoker, "Username and Password must be provided.").catch(() => {});

	var username = args.shift();
	var password = args.shift();

	//check for failed login attempts
	if (loginErrorsByUniqueID[invoker.uniqueIdentifier] !== undefined) {
		let currEpochMs = (new Date()).getTime();
		let loginError = loginErrorsByUniqueID[invoker.uniqueIdentifier];
		if ((loginError.epochMs + config.forumLoginErrorTimeoutMs) > currEpochMs) {
			if (loginError.count >= config.maxForumLoginAttempts) {
				loginError.epochMs = currEpochMs;
				let minutes = Math.round(config.forumLoginErrorTimeoutMs / 60000);
				console.log(`${invoker.nickname}[${invoker.uniqueIdentifier}] login failed for ${username} (too many attempts)`);
				return sendReplyToInvoker(invoker, `You have too many failed login attempts. Please wait ${minutes} minutes and try again.`).catch(() => {});
			}
		} else {
			//console.log(`deleting error for ${invoker.nickname}[${invoker.uniqueIdentifier}]`);
			delete loginErrorsByUniqueID[invoker.uniqueIdentifier];
		}
	}

	var promise = new Promise(function(resolve, reject) {
		let db = connectToDB();
		let password_md5 = db.escape(md5(password));
		let esc_username = db.escape(username);
		let query = `CALL check_user(${esc_username},${password_md5})`;
		db.query(query, function(err, rows, fields) {
			var success = false;
			if (!err) {
				//rows[i].userid
				//rows[i].username
				//rows[i].valid
				//should never be more than 1 user...
				if (rows && rows.length && rows[0][0]) {
					let data = rows[0][0];
					if (data && data.valid == 1) {
						success = true;
						let uniqueID = db.escape(invoker.uniqueIdentifier);
						let query2 =
							`SELECT u.userid,u.username FROM ${config.mysql.prefix}userfield f ` +
							`INNER JOIN ${config.mysql.prefix}user u ON f.userid=u.userid ` +
							`WHERE f.field18=${uniqueID} AND f.userid!=${data.userid}`;
						db.query(query2, function(err, rows2, fields) {
							if (rows2 && rows2.length) {
								let data2 = rows2[0];
								console.log(`Existing forum account found ${data2.username} ${data2.userid}`);
								//FIXME notify of overwrite
								query2 = `UPDATE ${config.mysql.prefix}userfield SET field19='',field20='' WHERE userid=${data2.userid}`;
								db.query(query2);
							}
						});

						query2 = `UPDATE ${config.mysql.prefix}userfield SET field18=${uniqueID} WHERE userid=${data.userid}`;
						db.query(query2, function(err, rows2, fields) {
							if (err) {
								sendReplyToInvoker(invoker, `Successfully logged in as ${data.username} (${data.userid}), but there was an error updating your user infomation.`).catch(() => {});
								console.log(err);
								return reject(err);
							}
							console.log(`${invoker.nickname}[${invoker.uniqueIdentifier}] logged in as ${data.username} (${data.userid})`);
							let msg = `Successfully logged in as ${data.username} (${data.userid}).`;
							sendReplyToInvoker(invoker, msg);
							setTSGroupsForInvoker(invoker);
							return resolve();
						});
					}
				}
			}
			if (!success) {
				//track login errors
				if (loginErrorsByUniqueID[invoker.uniqueIdentifier] === undefined)
					loginErrorsByUniqueID[invoker.uniqueIdentifier] = { epochMs: 0, count: 0 };
				loginErrorsByUniqueID[invoker.uniqueIdentifier].epochMs = (new Date()).getTime();
				loginErrorsByUniqueID[invoker.uniqueIdentifier].count++;

				console.log(`${invoker.nickname}[${invoker.uniqueIdentifier}] login failed for ${username} (count: ${loginErrorsByUniqueID[invoker.uniqueIdentifier].count})`);
				sendReplyToInvoker(invoker, `Login failed for ${username}.`).catch(() => {});
			}
			return resolve();
		});
	});
	return promise;
}

function commandQuit(invoker, cmd, args, perm, permName) {
	console.log(`Bot quit requested by ${invoker.nickname}[${invoker.uniqueIdentifier}]`);
	teamspeak.quit();
	process.exit();
}

function commandTest(invoker, cmd, args, perm, permName) {

}

//command definitions
commands = {
	/*
	command: {
		minPermission: PERM_LEVEL,
		args: array of "String" or "String",
		helpText: array of "String" or "String",
		callback: function(invoker, cmd, args, perm, permName)
		doLog: optional boolean (default true)
		logArgs: optional boolean (default true)
	},
	*/
	help: {
		minPermission: PERM_NONE,
		args: "[<command>]",
		helpText: "Displays the help menu. If <command> is present, only that command will be shown.",
		callback: commandHelp,
		doLog: false
	},
	login: {
		minPermission: PERM_NONE,
		args: ["\"<username|email>\"", "\"<password>\""],
		helpText: "Associate TeamSpeak ID to AOD forum account.",
		callback: commandLogin,
		logArgs: false
	},
	ping: {
		minPermission: PERM_GUEST,
		args: "",
		helpText: "Returns a DM letting you know the bot is alive. Staff and Moderators will get an estimate of network latency.",
		callback: commandPing,
		doLog: false
	},
	forumsync: {
		minPermission: PERM_MOD,
		args: ["<cmd>", "[<options>]"],
		helpText: ["Forum sync integration commands:",
			"*showmap*: Shows the current synchronization map",
			"*showtsgroups*: Shows the TeamSpeak groups eligible for integration",
			"*showforumgroups*: Shows the forum groups eligible for integration",
			"*check*: Checks for exceptions between forum groups and mapped discord roles",
			"*sync*: Adds and removes members from TeamSpeak groups based on forum groups",
			"*add \"<tsgroup>\" \"<group>\"*: Maps the forum <group> to the <tsgroup>",
			"*rem \"<tsgroup>\" \"<group>\"*: Removes the forum group from the map for the <tsgroup>"
		],
		callback: commandForumSync
	},
	reload: {
		minPermission: PERM_OWNER,
		args: "",
		helpText: "Reload the configuration",
		callback: commandReload,
	},
	status: {
		minPermission: PERM_ADMIN,
		args: "",
		helpText: "Bot Status",
		callback: commandStatus,
	},
	quit: {
		minPermission: PERM_OWNER,
		args: "",
		helpText: "Terminate the bot",
		callback: commandQuit,
	},
	/*test: {
		minPermission: PERM_OWNER,
		args: "",
		helpText: "Test the bot",
		callback: commandTest,
	},*/
};

//process commands
function processCommand(invoker, cmd, arg_string, perm, permName) {
	var commandObj = commands[cmd];
	if (commandObj !== undefined) {
		if (commandObj.minPermission <= perm) {
			var args = getParams(arg_string);
			if (commandObj.doLog !== false) {
				if (commandObj.logArgs !== false)
					console.log(`${invoker.nickname}[${invoker.uniqueIdentifier}] executed: ${cmd} "${args.join('" "')}"`);
				else
					console.log(`${invoker.nickname}[${invoker.uniqueIdentifier}] executed: ${cmd}`);
			}
			return commandObj.callback(invoker, cmd, args, perm, permName);
		}
	}
}

//message event handler -- triggered when client receives a message from a text channel or DM
teamspeak.on("textmessage", async evnt => {
	if (evnt.targetmode === 1 && whoami && evnt.invoker.databaseId !== whoami.clientDatabaseId) {
		//check for prefix
		if (!evnt.msg.startsWith(config.prefix)) return;

		[perm, permName] = getPermissionLevelForMember(evnt.invoker.servergroups);
		if (config.ownerUniqueIds.includes(evnt.invoker.uniqueIdentifier))
			perm = PERM_OWNER;

		//get command and argument string
		let first_space = evnt.msg.indexOf(' ');
		var command, arg_string;
		if (first_space < 0) {
			command = evnt.msg.slice(config.prefix.length).trim();
			arg_string = "";
		} else {
			command = evnt.msg.slice(config.prefix.length, first_space);
			arg_string = evnt.msg.slice(first_space + 1).trim();
		}

		try {
			return processCommand(evnt.invoker, command, arg_string, perm, permName);
		} catch (error) { console.error(error); } //don't let user input crash the bot
	}
});


var forumSyncTimer = null;
var lastDate = null;

function forumSyncTimerCallback() {
	lastForumSync = new Date();
	let currentDate = `${lastForumSync.getFullYear()}/${lastForumSync.getMonth()+1}/${lastForumSync.getDate()}`;
	let doDaily = false;

	//console.log(`Forum sync timer called; currentDate=${currentDate} lastDate=${lastDate}`);

	if (lastDate !== null && lastDate !== currentDate)
		doDaily = true;
	lastDate = currentDate;

	doForumSync(null, PERM_NONE, false, doDaily);
	//if (doDaily)

	//clearout expired login errors
	let currEpochMs = (new Date()).getTime();
	for (var id in loginErrorsByUniqueID) {
		if (loginErrorsByUniqueID.hasOwnProperty(id)) {
			let loginError = loginErrorsByUniqueID[id];
			if ((loginError.epochMs + config.forumLoginErrorTimeoutMs) < currEpochMs) {
				//console.log(`deleting error for ${member.user.tag} in timer`);
				delete loginErrorsByUniqueID[id];
			}
		}
	}
}

teamspeak.on("ready", async () => {
	connectTime = new Date();
	console.log("Bot started and connected to server");

	Promise.all([
		/*teamspeak.registerEvent("server"),
		teamspeak.registerEvent("channel", 0),
		teamspeak.registerEvent("textserver"),
		teamspeak.registerEvent("textchannel"),*/
		teamspeak.registerEvent("textprivate")
	]).then(() => { console.log('Bot registered for events'); }).catch((error) => { console.log('Error registering callbacks: ' + error); });

	// get local unique ID
	whoami = await teamspeak.whoami();

	forumSyncTimerCallback(); //prime the date and do initial adds
	forumSyncTimer = setInterval(forumSyncTimerCallback, config.forumSyncIntervalMS);
});

teamspeak.on("error", evnt => {
	console.log(evnt);
});

teamspeak.on("close", async evnt => {
	console.log("Disconnected, trying to reconnect...");
	await teamspeak.reconnect(-1, 1000);
	console.log("Reconnected to server");
	connectTime = new Date();
});
