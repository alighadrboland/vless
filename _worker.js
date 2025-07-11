// @ts-nocheck
// <!--GAMFC-->version base on commit 43fad05dcdae3b723c53c226f8181fc5bd47223e, time is 2023-06-22 15:20:02 UTC<!--GAMFC-END-->.
// @ts-ignore
import { connect } from 'cloudflare:sockets';

// How to generate your own UUID:
// https://www.uuidgenerator.net/
let userID = '788b7aa0-5f6d-4848-8ca0-c64932af8339';

const proxyIPs = [
    "8.222.128.131",
    "43.157.17.4",
    "8.219.247.203",
    "8.222.193.208",
    "143.47.227.23",
    "8.219.12.152",
    "8.219.201.174",
    "8.222.138.164",
];
let proxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];

let dohURL = 'https://cloudflare-dns.com/dns-query';

// v2board api environment variables
let nodeId = ''; // 1

let apiToken = ''; //abcdefghijklmnopqrstuvwxyz123456

let apiHost = ''; // api.v2board.com

if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string, DNS_RESOLVER_URL: string, NODE_ID: int, API_HOST: string, API_TOKEN: string}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			userID = env.UUID || userID;
			proxyIP = env.PROXYIP || proxyIP;
			dohURL = env.DNS_RESOLVER_URL || dohURL;
			nodeId = env.NODE_ID || nodeId;
			apiToken = env.API_TOKEN || apiToken;
			apiHost = env.API_HOST || apiHost;
			const upgradeHeader = request.headers.get('Upgrade');
			const lengthRegex = /^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)-(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$/;
			const intervalRegex = /^(?:[1-9]|[12][0-9]|30)-(?:[2-9]|[12][0-9]|30)$/;
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				const url = new URL(request.url);
				const searchParams = new URLSearchParams(url.search);
				const fragmentLength = searchParams.get('length');
				const fragmentInterval = searchParams.get('interval');
				const dnsAddress = searchParams.get('dns');
                const client = searchParams.get('app');

				switch (url.pathname) {
					case '/cf':
						return new Response(JSON.stringify(request.cf, null, 4), {
							status: 200,
							headers: {
								"Content-Type": "application/json;charset=utf-8",
							},
						});
					case '/connect': // for test connect to cf socket
						const [hostname, port] = ['cloudflare.com', '80'];
						console.log(`Connecting to ${hostname}:${port}...`);

						try {
							const socket = await connect({
								hostname: hostname,
								port: parseInt(port, 10),
							});

							const writer = socket.writable.getWriter();

							try {
								await writer.write(new TextEncoder().encode('GET / HTTP/1.1\r\nHost: ' + hostname + '\r\n\r\n'));
							} catch (writeError) {
								writer.releaseLock();
								await socket.close();
								return new Response(writeError.message, { status: 500 });
							}

							writer.releaseLock();

							const reader = socket.readable.getReader();
							let value;

							try {
								const result = await reader.read();
								value = result.value;
							} catch (readError) {
								await reader.releaseLock();
								await socket.close();
								return new Response(readError.message, { status: 500 });
							}

							await reader.releaseLock();
							await socket.close();

							return new Response(new TextDecoder().decode(value), { status: 200 });
						} catch (connectError) {
							return new Response(connectError.message, { status: 500 });
						}
					case `/${userID}`: {
						
						let length = '', interval = '';
						if (lengthRegex.test(fragmentLength) && Number(fragmentLength.split('-')[0]) < Number(fragmentLength.split('-')[1])) {
							length = fragmentLength;
						} else {
							length = "100-200";
						}

						if (intervalRegex.test(fragmentInterval) && Number(fragmentInterval.split('-')[0]) < Number(fragmentInterval.split('-')[1])) {
							interval = fragmentInterval;
						} else {
							interval = "10-20";
						}

						const vlessConfig = await getVLESSConfig(userID, request.headers.get('Host'), length, interval, dnsAddress ?? false, client);

						return new Response(`${vlessConfig}`, {
							status: 200,
							headers: {
								"Content-Type": "text/plain;charset=utf-8",
							},
						});
					}
					default:
						// return new Response('Not found', { status: 404 });
						// For any other path, reverse proxy to 'www.fmprc.gov.cn' and return the original response
						url.hostname = 'www.bing.com';
						url.protocol = 'https:';
						request = new Request(url, request);
						return await fetch(request);
				}
			} else {
				return await vlessOverWSHandler(request);
			}
		} catch (err) {
			/** @type {Error} */ let e = err;
			return new Response(e.toString());
		}
	},
};




/**
 * 
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function vlessOverWSHandler(request) {

	/** @type {import("@cloudflare/workers-types").WebSocket[]} */
	// @ts-ignore
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (/** @type {string} */ info, /** @type {string | undefined} */ event) => {
		console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	/** @type {{ value: import("@cloudflare/workers-types").Socket | null}}*/
	let remoteSocketWapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDns = false;

	// ws --> remote
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns && udpStreamWrite) {
				return udpStreamWrite(chunk);
			}
			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter()
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			const {
				hasError,
				message,
				portRemote = [443, 8443, 2053, 2083, 2087, 2096, 80, 8080, 8880, 2052, 2082, 2086, 2095],
				addressRemote = '',
				rawDataIndex,
				vlessVersion = new Uint8Array([0, 0]),
				isUDP,
			} = await processVlessHeader(chunk, userID);
			address = addressRemote;
			portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '
				} `;
			if (hasError) {
				// controller.error(message);
				throw new Error(message); // cf seems has bug, controller.error will not end stream
				// webSocket.close(1000, message);
				return;
			}
			// if UDP but port not DNS port, close it
			if (isUDP) {
				if (portRemote === 53) {
					isDns = true;
				} else {
					// controller.error('UDP proxy only enable for DNS which is port 53');
					throw new Error('UDP proxy only enable for DNS which is port 53'); // cf seems has bug, controller.error will not end stream
					return;
				}
			}
			// ["version", "附加信息长度 N"]
			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			// TODO: support udp here when cf runtime has udp support
			if (isDns) {
				const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
				udpStreamWrite = write;
				udpStreamWrite(rawClientData);
				return;
			}
			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
		},
		close() {
			log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			log(`readableWebSocketStream is abort`, JSON.stringify(reason));
		},
	})).catch((err) => {
		log('readableWebSocketStream pipeTo error', err);
	});

	return new Response(null, {
		status: 101,
		// @ts-ignore
		webSocket: client,
	});
}

let apiResponseCache = null;
let cacheTimeout = null;

/**
 * Fetches the API response from the server and caches it for future use.
 * @returns {Promise<object|null>} A Promise that resolves to the API response object or null if there was an error.
 */
async function fetchApiResponse() {
	const requestOptions = {
		method: 'GET',
		redirect: 'follow'
	};

	try {
		const response = await fetch(`https://${apiHost}/api/v1/server/UniProxy/user?node_id=${nodeId}&node_type=v2ray&token=${apiToken}`, requestOptions);

		if (!response.ok) {
			console.error('Error: Network response was not ok');
			return null;
		}
		const apiResponse = await response.json();
		apiResponseCache = apiResponse;

		// Refresh the cache every 5 minutes (300000 milliseconds)
		if (cacheTimeout) {
			clearTimeout(cacheTimeout);
		}
		cacheTimeout = setTimeout(() => fetchApiResponse(), 300000);

		return apiResponse;
	} catch (error) {
		console.error('Error:', error);
		return null;
	}
}

/**
 * Returns the cached API response if it exists, otherwise fetches the API response from the server and caches it for future use.
 * @returns {Promise<object|null>} A Promise that resolves to the cached API response object or the fetched API response object, or null if there was an error.
 */
async function getApiResponse() {
	if (!apiResponseCache) {
		return await fetchApiResponse();
	}
	return apiResponseCache;
}

/**
 * Checks if a given UUID is present in the API response.
 * @param {string} targetUuid The UUID to search for.
 * @returns {Promise<boolean>} A Promise that resolves to true if the UUID is present in the API response, false otherwise.
 */
async function checkUuidInApiResponse(targetUuid) {
	// Check if any of the environment variables are empty
	if (!nodeId || !apiToken || !apiHost) {
		return false;
	}

	try {
		const apiResponse = await getApiResponse();
		if (!apiResponse) {
			return false;
		}
		const isUuidInResponse = apiResponse.users.some(user => user.uuid === targetUuid);
		return isUuidInResponse;
	} catch (error) {
		console.error('Error:', error);
		return false;
	}
}

// Usage example:
//   const targetUuid = "65590e04-a94c-4c59-a1f2-571bce925aad";
//   checkUuidInApiResponse(targetUuid).then(result => console.log(result));

/**
 * Handles outbound TCP connections.
 *
 * @param {any} remoteSocket 
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log,) {
	async function connectAndWrite(address, port) {
		/** @type {import("@cloudflare/workers-types").Socket} */
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData); // first write, nomal is tls client hello
		writer.releaseLock();
		return tcpSocket;
	}

	// if the cf connect tcp socket have no incoming data, we retry to redirect ip
	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
		// no matter retry success or not, close websocket
		tcpSocket.closed.catch(error => {
			console.log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	// when remoteSocket is ready, pass to websocket
	// remote--> ws
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer
 * @param {string} earlyDataHeader for ws 0rtt
 * @param {(info: string)=> void} log for ws 0rtt
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				if (readableStreamCancel) {
					return;
				}
				const message = event.data;
				controller.enqueue(message);
			});

			// The event means that the client closed the client -> server stream.
			// However, the server -> client stream is still open until you call close() on the server side.
			// The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
			webSocketServer.addEventListener('close', () => {
				// client send close, need close server
				// if stream is cancel, skip controller.close
				safeCloseWebSocket(webSocketServer);
				if (readableStreamCancel) {
					return;
				}
				controller.close();
			}
			);
			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			}
			);
			// for ws 0rtt
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},

		pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
		},
		cancel(reason) {
			// 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
			// 2. if readableStream is cancel, all controller.close/enqueue need skip,
			// 3. but from testing controller.error still work even if readableStream is cancel
			if (readableStreamCancel) {
				return;
			}
			log(`ReadableStream was canceled, due to ${reason}`)
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	});

	return stream;

}

// https://xtls.github.io/development/protocols/vless.html
// https://github.com/zizifn/excalidraw-backup/blob/main/v2ray-protocol.excalidraw

/**
 * 
 * @param { ArrayBuffer} vlessBuffer 
 * @param {string} userID 
 * @returns 
 */
async function processVlessHeader(vlessBuffer, userID) {
	if (vlessBuffer.byteLength < 24) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isValidUser = false;
	let isUDP = false;
	const slicedBuffer = new Uint8Array(vlessBuffer.slice(1, 17));
	const slicedBufferString = stringify(slicedBuffer);

	const uuids = userID.includes(',') ? userID.split(",") : [userID];

	const checkUuidInApi = await checkUuidInApiResponse(slicedBufferString);
	isValidUser = uuids.some(userUuid => checkUuidInApi || slicedBufferString === userUuid.trim());

	console.log(`checkUuidInApi: ${await checkUuidInApiResponse(slicedBufferString)}, userID: ${slicedBufferString}`);

	if (!isValidUser) {
		return {
			hasError: true,
			message: 'invalid user',
		};
	}

	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	//skip opt for now

	const command = new Uint8Array(
		vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
	)[0];

	// 0x01 TCP
	// 0x02 UDP
	// 0x03 MUX
	if (command === 1) {
	} else if (command === 2) {
		isUDP = true;
	} else {
		return {
			hasError: true,
			message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
		};
	}
	const portIndex = 18 + optLength + 1;
	const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
	// port is big-Endian in raw data etc 80 == 0x005d
	const portRemote = new DataView(portBuffer).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressBuffer = new Uint8Array(
		vlessBuffer.slice(addressIndex, addressIndex + 1)
	);

	// 1--> ipv4  addressLength =4
	// 2--> domain name addressLength=addressBuffer[1]
	// 3--> ipv6  addressLength =16
	const addressType = addressBuffer[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
			)[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			// 2001:0db8:85a3:0000:0000:8a2e:0370:7334
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			// seems no need add [] for ipv6
			break;
		default:
			return {
				hasError: true,
				message: `invild  addressType is ${addressType}`,
			};
	}
	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		vlessVersion: version,
		isUDP,
	};
}


/**
 * 
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 * @param {(() => Promise<void>) | null} retry
 * @param {*} log 
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	// remote--> ws
	let remoteChunkCount = 0;
	let chunks = [];
	/** @type {ArrayBuffer | null} */
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false; // check if remoteSocket has incoming data
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {
				},
				/**
				 * 
				 * @param {Uint8Array} chunk 
				 * @param {*} controller 
				 */
				async write(chunk, controller) {
					hasIncomingData = true;
					// remoteChunkCount++;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error(
							'webSocket.readyState is not open, maybe close'
						);
					}
					if (vlessHeader) {
						webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
						vlessHeader = null;
					} else {
						// seems no need rate limit this, CF seems fix this??..
						// if (remoteChunkCount > 20000) {
						// 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
						// 	await delay(1);
						// }
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
					// safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(
				`remoteSocketToWS has exception `,
				error.stack || error
			);
			safeCloseWebSocket(webSocket);
		});

	// seems is cf connect socket have error,
	// 1. Socket.closed will have error
	// 2. Socket.readable will be close without any data coming
	if (hasIncomingData === false && retry) {
		log(`retry`)
		retry();
	}
}

/**
 * 
 * @param {string} base64Str 
 * @returns 
 */
function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { error: null };
	}
	try {
		// go use modified Base64 for URL rfc4648 which js atob not support
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { error };
	}
}

/**
 * This is not real UUID validation
 * @param {string} uuid 
 */
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
/**
 * Normally, WebSocket will not has exceptions when close.
 * @param {import("@cloudflare/workers-types").WebSocket} socket
 */
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) {
		throw TypeError("Stringified UUID is invalid");
	}
	return uuid;
}


/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 * @param {(string)=> void} log 
 */
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {

	let isVlessHeaderSent = false;
	const transformStream = new TransformStream({
		start(controller) {

		},
		transform(chunk, controller) {
			// udp message 2 byte is the the length of udp data
			// TODO: this should have bug, beacsue maybe udp chunk can be in two websocket message
			for (let index = 0; index < chunk.byteLength;) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(
					chunk.slice(index + 2, index + 2 + udpPakcetLength)
				);
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
		flush(controller) {
		}
	});

	// only handle dns udp for now
	transformStream.readable.pipeTo(new WritableStream({
		async write(chunk) {
			const resp = await fetch(dohURL, // dns server url
				{
					method: 'POST',
					headers: {
						'content-type': 'application/dns-message',
					},
					body: chunk,
				})
			const dnsQueryResult = await resp.arrayBuffer();
			const udpSize = dnsQueryResult.byteLength;
			// console.log([...new Uint8Array(dnsQueryResult)].map((x) => x.toString(16)));
			const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
			if (webSocket.readyState === WS_READY_STATE_OPEN) {
				log(`doh success and dns message length is ${udpSize}`);
				if (isVlessHeaderSent) {
					webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
				} else {
					webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
					isVlessHeaderSent = true;
				}
			}
		}
	})).catch((error) => {
		log('dns udp has error' + error)
	});

	const writer = transformStream.writable.getWriter();

	return {
		/**
		 * 
		 * @param {Uint8Array} chunk 
		 */
		write(chunk) {
			writer.write(chunk);
		}
	};
}

/**
 * 
 * @param {string} userID 
 * @param {string | null} hostName
 * @returns {string}
 */
const getVLESSConfig = async (userID, hostName, fragmentLength, fragmentInterval, dns, client) => {

	const remoteDNS = dns ? `https://${dns}/dns-query` : 'https://94.140.14.14/dns-query';
	const localDNS = dns ? dns : '1.1.1.1';
  	const alpn = (client === 'nekobox') || (client === 'hiddify-next') ? 'http/1.1' : 'h2,http/1.1'; 
	let vlessWsTls = '', fragConfig = '',fragConfigNekoray = '';

	await resolveDNS(hostName).then((addresses) => {

		const Address = ['www.speedtest.net', hostName, ...addresses.ipv4, ...addresses.ipv6.map(ip => `[${ip}]`)];
		Address.forEach(addr => {
			vlessWsTls += `vless://${userID}@${addr}:443?encryption=none&security=tls&type=ws&host=${randomUpperCase(hostName)}&sni=${randomUpperCase(hostName)}&fp=randomized&alpn=${alpn}&path=%2F${getRandomPath(16)}%3Fed%3D2048#Worker - ${addr}\n`;
		});

		if (client === 'nekobox' || client === 'hiddify-next') return vlessWsTls;

		Address.forEach( addr => {
            
			fragConfig = 
            `{
				"dns": {
					"hosts": {
						"geosite:category-ads-all": "127.0.0.1",
						"geosite:category-ads-ir": "127.0.0.1",
						"domain:googleapis.cn": "googleapis.com"
					},
					"servers": [
						"${remoteDNS}",
						{
							"address": "${localDNS}",
							"domains": [
								"geosite:private",
								"geosite:category-ir",
								"domain:.ir"
							],
							"expectIPs": [
								"geoip:cn"
							],
							"port": 53
						}
					]
				},
				"fakedns": [
					{
						"ipPool": "198.18.0.0/15",
						"poolSize": 10000
					}
				],
				"inbounds": [
					{
						"port": 10808,
						"protocol": "socks",
						"settings": {
							"auth": "noauth",
							"udp": true,
							"userLevel": 8
						},
						"sniffing": {
							"destOverride": [
								"http",
								"tls",
								"fakedns"
							],
							"enabled": true
						},
						"tag": "socks"
					},
					{
						"port": 10809,
						"protocol": "http",
						"settings": {
							"userLevel": 8
						},
						"tag": "http"
					}
				],
				"log": {
					"loglevel": "warning"
				},
				"outbounds": [
					{
						"protocol": "vless",
						"settings": {
							"vnext": [
								{
									"address": "${addr}",
									"port": 443,
									"users": [
										{
											"encryption": "none",
											"flow": "",
											"id": "${userID}",
											"level": 8,
											"security": "auto"
										}
									]
								}
							]
						},
						"streamSettings": {
							"network": "ws",
							"security": "tls",
							"tlsSettings": {
								"allowInsecure": false,
								"alpn": [
									"h2",
									"http/1.1"
								],
								"fingerprint": "chrome",
								"publicKey": "",
								"serverName": "${randomUpperCase(hostName)}",
								"shortId": "",
								"show": false,
								"spiderX": ""
							},
							"wsSettings": {
								"headers": {
									"Host": "${randomUpperCase(hostName)}"
								},
								"path": "/${getRandomPath(16)}?ed=2048"
							},
							"sockopt": {
								"dialerProxy": "fragment",
								"tcpKeepAliveIdle": 100,
								"tcpNoDelay": true
							}
						},
						"tag": "proxy"
					},
					{
						"tag": "fragment",
						"protocol": "freedom",
						"settings": {
							"domainStrategy": "AsIs",
							"fragment": {
								"packets": "tlshello",
								"length": "${fragmentLength}",
								"interval": "${fragmentInterval}"
							}
						},
						"streamSettings": {
							"sockopt": {
								"TcpNoDelay": true
							}
						}
					},
					{
						"protocol": "freedom",
						"settings": {
							"domainStrategy": "UseIP"
						},
						"tag": "direct"
					},
					{
						"protocol": "blackhole",
						"settings": {
							"response": {
								"type": "http"
							}
						},
						"tag": "block"
					}
				],
				"policy": {
					"levels": {
						"8": {
							"connIdle": 300,
							"downlinkOnly": 1,
							"handshake": 4,
							"uplinkOnly": 1
						}
					},
					"system": {
						"statsOutboundUplink": true,
						"statsOutboundDownlink": true
					}
				},
				"routing": {
					"domainStrategy": "IPIfNonMatch",
					"rules": [
						{
							"ip": [
								"${localDNS}"
							],
							"outboundTag": "direct",
							"port": "53",
							"type": "field"
						},
						{
							"domain": [
								"geosite:private",
								"geosite:category-ir",
								"domain:.ir"
							],
							"outboundTag": "direct",
							"type": "field"
						},
						{
							"ip": [
								"geoip:private",
								"geoip:ir"
							],
							"outboundTag": "direct",
							"type": "field"
						},
						{
							"domain": [
								"geosite:category-ads-all",
								"geosite:category-ads-ir"
							],
							"outboundTag": "block",
							"type": "field"
						}
					]
				},
				"stats": {}
			}`;


            fragConfigNekoray = 
            `{
                "dns": {
                "disableFallback": true,
                "servers": [
                    {
                    "address": "${remoteDNS}",
                    "domains": [],
                    "queryStrategy": ""
                    },
                    {
                    "address": "${localDNS}",
                    "domains": [ "domain:.ir", "geosite:private", "geosite:category-ir"],
                    "queryStrategy": ""
                    }
                ],
                "tag": "dns"
                },
                "inbounds": [
                {
                    "listen": "127.0.0.1",
                    "port": 2080,
                    "protocol": "socks",
                    "settings": { "udp": true },
                    "sniffing": {
                    "destOverride": ["http", "tls", "quic"],
                    "enabled": true,
                    "metadataOnly": false,
                    "routeOnly": true
                    },
                    "tag": "socks-in"
                },
                {
                    "listen": "127.0.0.1",
                    "port": 2081,
                    "protocol": "http",
                    "sniffing": {
                    "destOverride": ["http", "tls", "quic"],
                    "enabled": true,
                    "metadataOnly": false,
                    "routeOnly": true
                    },
                    "tag": "http-in"
                }
                ],
                "log": { "loglevel": "warning" },
                "outbounds": [
                {
                    "domainStrategy": "AsIs",
                    "flow": null,
                    "protocol": "vless",
                    "settings": {
                    "vnext": [
                        {
                        "address": "${addr}",
                        "port": 443,
                        "users": [
                            {
                            "encryption": "none",
                            "flow": "",
                            "id": "${userID}"
                            }
                        ]
                        }
                    ]
                    },
                    "streamSettings": {
                    "network": "ws",
                    "security": "tls",
                    "sockopt": {
			"dialerProxy": "fragment",
			"tcpKeepAliveIdle": 100,
			"tcpNoDelay": true
		    },
                    "tlsSettings": {
                        "alpn": ["h2", "http/1.1"],
                        "fingerprint": "chrome",
                        "serverName": "${randomUpperCase(hostName)}"
                    },
                    "wsSettings": {
                        "headers": {
                        "Host": "${randomUpperCase(hostName)}"
                        },
                        "path": "${getRandomPath(16)}?ed=2048"
                    }
                    },
                    "tag": "proxy"
                },
                {
                    "protocol": "freedom",
                    "settings": {
	                    "domainStrategy": "AsIs",
	                    "fragment": {
	                        "interval": "${fragmentInterval}",
	                        "length": "${fragmentLength}",
	                        "packets": "tlshello"
	                    }
                    },
		    "streamSettings": {
    			"sockopt": {
      				"TcpNoDelay": true
    			}
  		    },
                    "tag": "fragment"
                },
                { "domainStrategy": "", "protocol": "freedom", "tag": "bypass" },
                { "protocol": "blackhole", "tag": "block" },
                {
                    "protocol": "dns",
                    "proxySettings": { "tag": "proxy", "transportLayer": true },
                    "settings": {
                    "address": "${localDNS}",
                    "network": "tcp",
                    "port": 53,
                    "userLevel": 1
                    },
                    "tag": "dns-out"
                }
                ],
                "policy": {
                "levels": { "1": { "connIdle": 30 } },
                "system": { "statsOutboundDownlink": true, "statsOutboundUplink": true }
                },
                "routing": {
                "domainStrategy": "IPIfNonMatch",
                "rules": [
                    { "ip": ["${localDNS}"], "outboundTag": "bypass", "type": "field" },
                    {
                    "inboundTag": ["socks-in", "http-in"],
                    "outboundTag": "dns-out",
                    "port": "53",
                    "type": "field"
                    },
                    {
                        "domain": ["geosite:category-ads-all", "geosite:category-ads-ir"],
                        "outboundTag": "block",
                        "type": "field"
                    },
                    {
                        "ip": ["geoip:ir", "geoip:private"],
                        "outboundTag": "bypass",
                        "type": "field"
                    },
                    {
                        "domain": ["geosite:private", "geosite:category-ir", "domain:.ir"],
                        "outboundTag": "bypass",
                        "type": "field"
                    },
                    { "outboundTag": "proxy", "port": "0-65535", "type": "field" }
                ]
                },
                "stats": {}
            }`;

            vlessWsTls += `\n\n\n💥💥 Address: ${addr} 💥💥\n\n\n`;
            vlessWsTls += client === 'nekoray' ? fragConfigNekoray.replace(/\s/g, "") : fragConfig.replace(/\s/g, "");
		});
	});

	return `${vlessWsTls}`;
}

const randomUpperCase = (str) => {

	let result = "";
	for (let i = 0; i < str.length; i++) {
		result += Math.random() < 0.5 ? str[i].toUpperCase() : str[i];
	}
	return result;
}

const getRandomPath = (length) => {

	const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789---___';
	let result = '';

	for (let i = 0; i < length; i++) {
		const randomIndex = Math.floor(Math.random() * characters.length);
		result += characters.charAt(randomIndex);
	}

	return result;
}

const resolveDNS = async (domain) => {

	const dohURLv4 = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`;
	const dohURLv6 = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=AAAA`;

	try {
		const [ipv4Response, ipv6Response] = await Promise.all([
			fetch(dohURLv4, { headers: { "accept": "application/dns-json" } }),
			fetch(dohURLv6, { headers: { "accept": "application/dns-json" } }),
		]);

		const ipv4Addresses = await ipv4Response.json();
		const ipv6Addresses = await ipv6Response.json();

		const ipv4 = ipv4Addresses.Answer ? ipv4Addresses.Answer.map(record => record.data) : [];
		const ipv6 = ipv6Addresses.Answer ? ipv6Addresses.Answer.map(record => record.data) : [];

		return { ipv4, ipv6 };

	} catch (error) {
		console.error('Error resolving DNS:', error);
	}
}

