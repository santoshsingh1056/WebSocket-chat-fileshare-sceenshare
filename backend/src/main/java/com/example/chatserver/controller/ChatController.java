package com.example.chatserver.controller;

import com.example.chatserver.model.ChatMessage;
import com.example.chatserver.repository.ChatMessageRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;

import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Set;


@Controller
public class ChatController {

    @Autowired
    private SimpMessagingTemplate messagingTemplate;

    @Autowired
    private ChatMessageRepository chatMessageRepository;

    // Using a thread-safe set for managing active users
    private static final Set<String> activeUsers = ConcurrentHashMap.newKeySet();

    @MessageMapping("/chat.sendMessage")
    public void sendMessage(@Payload ChatMessage chatMessage) {
        // Save the chat message to the database
        chatMessageRepository.save(chatMessage);

        // FIX: Replaced convertAndSendToUser with the more direct convertAndSend.
        // This sends the message directly to the specific queue the recipient user is subscribed to.
        // This is a more robust approach when not using Spring Security for principal management.
        messagingTemplate.convertAndSend("/user/" + chatMessage.getRecipient() + "/queue/messages", chatMessage);
    }

    @MessageMapping("/chat.addUser")
    public void addUser(@Payload ChatMessage chatMessage, SimpMessageHeaderAccessor headerAccessor) {
        String username = chatMessage.getSender();
        // Add username to WebSocket session attributes, can be useful for other purposes like disconnect events.
        Objects.requireNonNull(headerAccessor.getSessionAttributes()).put("username", username);
        activeUsers.add(username);

        // Announce the updated user list to all clients
        messagingTemplate.convertAndSend("/topic/public", activeUsers);
    }

    @MessageMapping("/chat.webrtc.signal")
    public void handleSignaling(@Payload ChatMessage signalMessage) {
        // FIX: Replaced convertAndSendToUser here as well for the same reason as in sendMessage.
        // This ensures WebRTC signaling data is correctly routed to the recipient.
        messagingTemplate.convertAndSend("/user/" + signalMessage.getRecipient() + "/queue/webrtc", signalMessage);
    }
}
