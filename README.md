# Fighter Game

A multiplayer, low-latency, web-based fighting game built with Phaser 3 and Socket.io.

## Features

- **Multiplayer**: Real-time multiplayer combat with up to multiple players
- **Combat System**: Attack and blocking mechanics with damage calculation
- **Health System**: Visual health bars and damage indicators
- **Knockback Effects**: Players get knocked back when hit
- **Visual Feedback**: Attack animations and blocking states
- **Responsive Controls**: Smooth movement and combat controls

## Controls

- **Arrow Keys**: Move your fighter
- **Spacebar**: Attack
- **Z Key**: Block (reduces damage by 70%)

## Setup Instructions

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Start the Server**
   ```bash
   npm start
   ```
   Or for development with auto-restart:
   ```bash
   npm run dev
   ```

3. **Open the Game**
   - Navigate to `http://localhost:3000` in your web browser
   - Open multiple browser tabs/windows to play with multiple players

## Game Mechanics

### Combat
- **Attack Range**: 70 pixels
- **Attack Damage**: 15 health points
- **Attack Cooldown**: 500ms between attacks
- **Blocking**: Reduces incoming damage by 70%
- **Knockback**: Players are pushed back when hit

### Movement
- **Normal Speed**: 4 pixels per frame
- **Blocking Speed**: 2 pixels per frame (50% reduction)
- **Boundaries**: Players are kept within the game area

### Health System
- **Starting Health**: 100 HP
- **Health Bar Colors**: 
  - Green: >60% health
  - Yellow: 30-60% health
  - Red: <30% health
- **Death**: Players become gray and cannot move when health reaches 0

### Visual Indicators
- **Red Fighter**: Your character
- **Blue Fighter**: Other players
- **Yellow Fighter**: Player is blocking
- **Gray Fighter**: Player is defeated
- **Yellow Circle**: Attack animation

## Technical Details

- **Server**: Node.js with Express and Socket.io
- **Client**: Phaser 3 game engine
- **Frame Rate**: 60 FPS server tick rate
- **Network**: Real-time WebSocket communication

## File Structure

```
fighter/
├── server.js          # Game server
├── package.json       # Dependencies
├── public/
│   └── index.html     # Game client
└── README.md          # This file
```

## Future Enhancements

- Multiple levels/arenas
- Different fighter types with unique abilities
- Power-ups and special attacks
- Spectator mode
- Leaderboards
- Sound effects and music
- Mobile touch controls

## Troubleshooting

- **Port Already in Use**: Change the PORT in server.js or kill the existing process
- **Connection Issues**: Ensure your firewall allows connections on port 3000
- **Performance**: Close other applications if experiencing lag

Enjoy fighting! 🥊 