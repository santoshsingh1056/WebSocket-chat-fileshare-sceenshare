import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Client } from '@stomp/stompjs';
import SockJS from 'sockjs-client';
import axios from 'axios';
import { User, Paperclip, Send, ScreenShare, X } from 'lucide-react';

const API_URL = 'http://localhost:8080';

// A single RTCPeerConnection instance
let peerConnection;
// Google's public STUN servers
const peerConnectionConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function App() {
    const [stompClient, setStompClient] = useState(null);
    const [username, setUsername] = useState('');
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [activeUsers, setActiveUsers] = useState([]);
    const [currentChat, setCurrentChat] = useState(null);
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState('');
    
    // Screen sharing state
    const [isSharingScreen, setIsSharingScreen] = useState(false);
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);
    const localStreamRef = useRef(null);
    
    const fileInputRef = useRef(null);

    // ---- WebSocket and Chat Logic ----

    const connect = useCallback(() => {
        const socket = new SockJS(`${API_URL}/ws`);
        const client = new Client({
            webSocketFactory: () => socket,
            reconnectDelay: 5000,
            onConnect: () => {
                console.log('Connected to WebSocket');
                setStompClient(client);

                // Subscribe to public topic for user list updates
                client.subscribe('/topic/public', (message) => {
                    const updatedUsers = JSON.parse(message.body);
                    setActiveUsers(updatedUsers.filter(u => u !== username));
                });

                // Subscribe to user-specific queue for private messages
                client.subscribe(`/user/${username}/queue/messages`, (message) => {
                    const receivedMessage = JSON.parse(message.body);
                    setMessages(prev => [...prev, receivedMessage]);
                });

                // Subscribe to user-specific queue for WebRTC signals
                client.subscribe(`/user/${username}/queue/webrtc`, (message) => {
                    handleSignalingData(JSON.parse(message.body));
                });

                // Announce user joining
                client.publish({
                    destination: '/app/chat.addUser',
                    body: JSON.stringify({ sender: username, type: 'JOIN' }),
                });
            },
            onDisconnect: () => {
                console.log('Disconnected');
                // Clean up on disconnect
                if(localStreamRef.current) {
                    localStreamRef.current.getTracks().forEach(track => track.stop());
                }
                if(peerConnection) {
                    peerConnection.close();
                }
                setIsSharingScreen(false);
            },
            onStompError: (frame) => {
                console.error('Broker reported error: ' + frame.headers['message']);
                console.error('Additional details: ' + frame.body);
            },
        });

        client.activate();
    }, [username]);

    const handleLogin = (e) => {
        e.preventDefault();
        if (username.trim()) {
            setIsLoggedIn(true);
        }
    };
    
    useEffect(() => {
        if(isLoggedIn) {
            connect();
        }
    }, [isLoggedIn, connect]);
    
    const sendMessage = (content, type = 'CHAT') => {
        if (stompClient && currentChat && (content.trim() || type !== 'CHAT')) {
            const chatMessage = {
                sender: username,
                recipient: currentChat,
                content: content,
                type: type,
            };
            stompClient.publish({
                destination: '/app/chat.sendMessage',
                body: JSON.stringify(chatMessage),
            });
            // Add sent message to local state immediately
            setMessages(prev => [...prev, { ...chatMessage, timestamp: new Date().toISOString() }]);
            setInputValue('');
        }
    };
    
    const handleFileUpload = async (event) => {
        const file = event.target.files[0];
        if (!file || !currentChat) return;

        const formData = new FormData();
        formData.append('file', file);
        
        try {
            const response = await axios.post(`${API_URL}/uploadFile`, formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            const fileUrl = response.data;
            sendMessage(fileUrl, 'FILE');
        } catch (error) {
            console.error('Error uploading file:', error);
            // Replaced alert with a console log
            console.error('File upload failed.');
        }
        // Reset file input
        fileInputRef.current.value = "";
    };

    // ---- WebRTC Screen Sharing Logic ----

    const handleSignalingData = (data) => {
        if (!peerConnection) createPeerConnection();
        // The data.content will contain the SDP or ICE candidate
        const signal = JSON.parse(data.content);
        if (signal.sdp) {
            peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp))
                .then(() => {
                    if (signal.sdp.type === 'offer') {
                        createAnswer();
                    }
                }).catch(e => console.error("Error setting remote description:", e));
        } else if (signal.ice) {
            peerConnection.addIceCandidate(new RTCIceCandidate(signal.ice))
                .catch(e => console.error("Error adding received ice candidate", e));
        }
    };
    
    const createPeerConnection = () => {
        peerConnection = new RTCPeerConnection(peerConnectionConfig);
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && stompClient && currentChat) {
                const signalPayload = {
                    sender: username,
                    recipient: currentChat,
                    content: JSON.stringify({ 'ice': event.candidate }),
                    type: 'SIGNAL'
                };
                 stompClient.publish({
                    destination: '/app/chat.webrtc.signal',
                    body: JSON.stringify(signalPayload),
                });
            }
        };

        peerConnection.ontrack = (event) => {
             if (remoteVideoRef.current && event.streams[0]) {
                remoteVideoRef.current.srcObject = event.streams[0];
                setIsSharingScreen(true); // Show video elements
            }
        };
    };
    
    const createOffer = () => {
         if (!peerConnection) createPeerConnection();
         localStreamRef.current.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStreamRef.current);
        });

        peerConnection.createOffer()
            .then(offer => peerConnection.setLocalDescription(offer))
            .then(() => {
                if (stompClient && currentChat) {
                   const signalPayload = {
                        sender: username,
                        recipient: currentChat,
                        content: JSON.stringify({ 'sdp': peerConnection.localDescription }),
                        type: 'SIGNAL'
                    };
                    stompClient.publish({
                        destination: '/app/chat.webrtc.signal',
                        body: JSON.stringify(signalPayload),
                    });
                }
            }).catch(e => console.error("Error creating offer:", e));
    };
    
    const createAnswer = () => {
        peerConnection.createAnswer()
            .then(answer => peerConnection.setLocalDescription(answer))
            .then(() => {
                 if (stompClient && currentChat) {
                    const signalPayload = {
                        sender: username,
                        recipient: currentChat,
                        content: JSON.stringify({ 'sdp': peerConnection.localDescription }),
                        type: 'SIGNAL'
                    };
                    stompClient.publish({
                        destination: '/app/chat.webrtc.signal',
                        body: JSON.stringify(signalPayload),
                    });
                 }
            }).catch(e => console.error("Error creating answer:", e));
    };

    const startScreenShare = async () => {
        if (!currentChat) {
            console.error("Please select a user to share your screen with.");
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            localStreamRef.current = stream;
            if (localVideoRef.current) {
                localVideoRef.current.srcObject = stream;
            }
            setIsSharingScreen(true);
            createOffer();
        } catch (error) {
            console.error("Error starting screen share:", error);
            console.error("Could not start screen sharing. Please grant permissions.");
        }
    };
    
    const stopScreenShare = () => {
        if(localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => track.stop());
            localStreamRef.current = null;
        }
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        setIsSharingScreen(false);
        if(localVideoRef.current) localVideoRef.current.srcObject = null;
        if(remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    };


    // UI Rendering
    if (!isLoggedIn) {
        return <LoginScreen username={username} setUsername={setUsername} handleLogin={handleLogin} />;
    }

    return (
        <div className="flex h-screen antialiased text-gray-800 bg-gray-100">
            <div className="flex flex-row h-full w-full overflow-x-hidden">
                <UserList users={activeUsers} setCurrentChat={setCurrentChat} currentChat={currentChat} username={username} />
                <div className="flex flex-col flex-auto h-full p-6">
                   {currentChat ? (
                        <div className="flex flex-col flex-auto flex-shrink-0 rounded-2xl bg-white h-full p-4 relative">
                            <ChatHeader 
                                user={currentChat} 
                                onShare={startScreenShare} 
                                onStopShare={stopScreenShare}
                                isSharing={isSharingScreen}
                            />
                            {isSharingScreen && <ScreenShareView localRef={localVideoRef} remoteRef={remoteVideoRef} />}
                            <MessageArea messages={messages} username={username} />
                            <MessageInput 
                                value={inputValue} 
                                setValue={setInputValue} 
                                onSend={sendMessage}
                                onFileClick={() => fileInputRef.current.click()}
                            />
                            <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" />
                        </div>
                   ) : (
                        <WelcomeScreen />
                   )}
                </div>
            </div>
        </div>
    );
}

// ---- Sub-components ----

const LoginScreen = ({ username, setUsername, handleLogin }) => (
    <div className="min-h-screen bg-gray-100 flex flex-col justify-center sm:py-12">
        <div className="p-10 xs:p-0 mx-auto md:w-full md:max-w-md">
            <h1 className="font-bold text-center text-2xl mb-5">React Chat</h1>
            <div className="bg-white shadow w-full rounded-lg divide-y divide-gray-200">
                <form onSubmit={handleLogin} className="px-5 py-7">
                    <label className="font-semibold text-sm text-gray-600 pb-1 block">Username</label>
                    <input 
                        type="text" 
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="border rounded-lg px-3 py-2 mt-1 mb-5 text-sm w-full" 
                        placeholder="Enter your username"
                        required
                    />
                    <button 
                        type="submit" 
                        className="transition duration-200 bg-blue-500 hover:bg-blue-600 focus:bg-blue-700 focus:shadow-sm focus:ring-4 focus:ring-blue-500 focus:ring-opacity-50 text-white w-full py-2.5 rounded-lg text-sm shadow-sm hover:shadow-md font-semibold text-center inline-block"
                    >
                        <span className="inline-block mr-2">Join Chat</span>
                    </button>
                </form>
            </div>
        </div>
    </div>
);

const UserList = ({ users, setCurrentChat, currentChat, username }) => (
    <div className="flex flex-col py-8 pl-6 pr-2 w-64 bg-white flex-shrink-0">
        <div className="flex flex-row items-center justify-center h-12 w-full">
            <div className="flex items-center justify-center rounded-2xl text-indigo-700 bg-indigo-100 h-10 w-10">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path></svg>
            </div>
            <div className="ml-2 font-bold text-2xl">Chat App</div>
        </div>
        <div className="flex flex-col items-center bg-indigo-100 border border-gray-200 mt-4 w-full py-6 px-4 rounded-lg">
            <div className="h-20 w-20 rounded-full border overflow-hidden"><User className="h-full w-full" /></div>
            <div className="text-sm font-semibold mt-2">{username}</div>
            <div className="text-xs text-gray-500">Logged In</div>
        </div>
        <div className="flex flex-col mt-8">
            <div className="flex flex-row items-center justify-between text-xs">
                <span className="font-bold">Active Users</span>
                <span className="flex items-center justify-center bg-gray-300 h-4 w-4 rounded-full">{users.length}</span>
            </div>
            <div className="flex flex-col space-y-1 mt-4 -mx-2 h-48 overflow-y-auto">
                {users.map(user => (
                    <button key={user} onClick={() => setCurrentChat(user)} className={`flex flex-row items-center hover:bg-gray-100 rounded-xl p-2 ${currentChat === user ? 'bg-gray-200' : ''}`}>
                        <div className="flex items-center justify-center h-8 w-8 bg-indigo-200 rounded-full"><User size={20} /></div>
                        <div className="ml-2 text-sm font-semibold">{user}</div>
                    </button>
                ))}
            </div>
        </div>
    </div>
);

const ChatHeader = ({ user, onShare, onStopShare, isSharing }) => (
    <div className="flex sm:items-center justify-between py-3 border-b-2 border-gray-200">
        <div className="relative flex items-center space-x-4">
            <div className="relative">
                <span className="absolute text-green-500 right-0 bottom-0"><svg width="20" height="20"><circle cx="8" cy="8" r="8" fill="currentColor"></circle></svg></span>
                <div className="flex items-center justify-center h-10 sm:h-12 w-10 sm:w-12 rounded-full bg-indigo-200"><User size={24} /></div>
            </div>
            <div className="flex flex-col leading-tight">
                <div className="text-xl sm:text-2xl font-semibold mt-1 flex items-center"><span className="text-gray-700 mr-3">{user}</span></div>
                <span className="text-sm text-gray-600">Active</span>
            </div>
        </div>
        <div className="flex items-center space-x-2">
            {!isSharing ? (
                <button onClick={onShare} type="button" className="inline-flex items-center justify-center rounded-lg border h-10 w-10 transition duration-500 ease-in-out text-gray-500 hover:bg-gray-300 focus:outline-none">
                    <ScreenShare size={20}/>
                </button>
            ) : (
                 <button onClick={onStopShare} type="button" className="inline-flex items-center justify-center rounded-lg border h-10 w-10 transition duration-500 ease-in-out text-white bg-red-500 hover:bg-red-600 focus:outline-none">
                    <X size={20}/>
                </button>
            )}
        </div>
    </div>
);

const ScreenShareView = ({ localRef, remoteRef }) => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 my-2 p-2 border rounded-lg bg-gray-100">
        <div>
            <p className="text-sm font-semibold text-center">Your Screen</p>
            <video ref={localRef} autoPlay playsInline muted className="w-full h-auto bg-black rounded-md" />
        </div>
        <div>
            <p className="text-sm font-semibold text-center">Remote Screen</p>
            <video ref={remoteRef} autoPlay playsInline className="w-full h-auto bg-black rounded-md" />
        </div>
    </div>
);

const MessageArea = ({ messages, username }) => {
    const endOfMessagesRef = useRef(null);
    useEffect(() => {
        endOfMessagesRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    return (
        <div id="messages" className="flex flex-col space-y-4 p-3 overflow-y-auto scrollbar-thumb-blue scrollbar-thumb-rounded scrollbar-track-blue-lighter scrollbar-w-2 scrolling-touch">
            {messages.map((msg, index) => {
                const isMyMessage = msg.sender === username;
                if (msg.type === 'CHAT') {
                    return <ChatMessage key={index} msg={msg} isMyMessage={isMyMessage} />;
                }
                if (msg.type === 'FILE') {
                    return <FileMessage key={index} msg={msg} isMyMessage={isMyMessage} />;
                }
                return null;
            })}
            <div ref={endOfMessagesRef} />
        </div>
    );
};

const ChatMessage = ({ msg, isMyMessage }) => (
    <div className={`flex items-end ${isMyMessage ? 'justify-end' : ''}`}>
        <div className={`flex flex-col space-y-2 text-sm max-w-xs mx-2 order-${isMyMessage ? 2 : 1} items-${isMyMessage ? 'end' : 'start'}`}>
            <div>
                <span className={`px-4 py-2 rounded-lg inline-block ${isMyMessage ? 'rounded-br-none bg-blue-600 text-white' : 'rounded-bl-none bg-gray-300 text-gray-600'}`}>
                    {msg.content}
                </span>
            </div>
        </div>
        <div className={`flex items-center justify-center h-6 w-6 rounded-full bg-indigo-200 order-${isMyMessage ? 1 : 2}`}>
            <User size={14}/>
        </div>
    </div>
);

const FileMessage = ({ msg, isMyMessage }) => (
     <div className={`flex items-end ${isMyMessage ? 'justify-end' : ''}`}>
        <div className={`flex flex-col space-y-2 text-sm max-w-xs mx-2 order-${isMyMessage ? 2 : 1} items-${isMyMessage ? 'end' : 'start'}`}>
            <div>
                <a 
                    href={`${API_URL}${msg.content}`} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className={`px-4 py-2 rounded-lg inline-flex items-center gap-2 ${isMyMessage ? 'rounded-br-none bg-green-600 text-white' : 'rounded-bl-none bg-green-200 text-gray-800'}`}
                >
                    <Paperclip size={16} />
                    <span>Shared File</span>
                </a>
            </div>
        </div>
        <div className={`flex items-center justify-center h-6 w-6 rounded-full bg-indigo-200 order-${isMyMessage ? 1 : 2}`}>
            <User size={14}/>
        </div>
    </div>
);

const MessageInput = ({ value, setValue, onSend, onFileClick }) => (
    <div className="border-t-2 border-gray-200 px-4 pt-4 mb-2 sm:mb-0">
        <div className="relative flex">
            <button onClick={onFileClick} className="absolute left-0 top-0 mt-3 ml-2 text-gray-500 hover:text-gray-700">
                <Paperclip size={24} />
            </button>
            <input 
                type="text" 
                placeholder="Write your message!" 
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && onSend(value)}
                className="w-full focus:outline-none focus:placeholder-gray-400 text-gray-600 placeholder-gray-600 pl-12 bg-gray-200 rounded-md py-3" 
            />
            <div className="absolute right-0 items-center inset-y-0 hidden sm:flex">
                <button 
                    type="button" 
                    onClick={() => onSend(value)}
                    className="inline-flex items-center justify-center rounded-lg px-4 py-3 transition duration-500 ease-in-out text-white bg-blue-500 hover:bg-blue-400 focus:outline-none"
                >
                    <span className="font-bold">Send</span>
                    <Send size={18} className="ml-2" />
                </button>
            </div>
        </div>
    </div>
);

const WelcomeScreen = () => (
    <div className="flex flex-col items-center justify-center h-full text-center">
        <div className="text-2xl font-semibold text-gray-500">Welcome to the Chat!</div>
        <p className="text-gray-400 mt-2">Select a user from the list on the left to start a conversation.</p>
    </div>
);


export default App;