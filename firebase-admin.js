// Firebase Admin SDK Configuration for Server-Side Operations
// This file handles Firebase Admin initialization and user management

const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// Firebase Admin configuration using environment variables
const serviceAccountConfig = {
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_ADMIN_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_ADMIN_PRIVATE_KEY ? 
        process.env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, '\n') : null,
    client_email: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_ADMIN_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(process.env.FIREBASE_ADMIN_CLIENT_EMAIL)}`,
    universe_domain: "googleapis.com"
};

// Validate required environment variables
if (!serviceAccountConfig.project_id || !serviceAccountConfig.private_key || !serviceAccountConfig.client_email) {
    throw new Error('Missing required Firebase Admin environment variables. Please check your .env file.');
}

// Initialize Firebase Admin
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccountConfig),
            projectId: process.env.FIREBASE_PROJECT_ID
        });
        console.log('Firebase Admin initialized successfully');
    } catch (error) {
        console.error('Firebase Admin initialization error:', error.message);
        console.log('Running without Firebase Admin - some features may be limited');
    }
}

const auth = admin.auth();
const firestore = admin.firestore();

// User management class for server-side operations
class ServerAuthManager {
    constructor() {
        this.jwtSecret = process.env.JWT_SECRET;
        if (!this.jwtSecret) {
            throw new Error('JWT_SECRET environment variable is required for security');
        }
        this.isFirebaseAvailable = admin.apps.length > 0;
    }

    // Verify Firebase ID token from client
    async verifyIdToken(idToken) {
        if (!this.isFirebaseAvailable) {
            console.warn('Firebase Admin not available - skipping token verification');
            return { success: false, error: 'Firebase not configured' };
        }

        try {
            const decodedToken = await auth.verifyIdToken(idToken);
            
            // Get user data from Firestore
            const userDoc = await firestore.collection('users').doc(decodedToken.uid).get();
            const userData = userDoc.exists ? userDoc.data() : null;
            
            return {
                success: true,
                user: {
                    uid: decodedToken.uid,
                    email: decodedToken.email,
                    displayName: userData?.displayName || decodedToken.name,
                    isGuest: userData?.isGuest || decodedToken.firebase?.sign_in_provider === 'anonymous',
                    isAnonymous: decodedToken.firebase?.sign_in_provider === 'anonymous',
                    userData: userData
                }
            };
        } catch (error) {
            console.error('Token verification error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Create custom JWT token for user session
    createCustomToken(user) {
        const payload = {
            uid: user.uid,
            displayName: user.displayName,
            isGuest: user.isGuest || false,
            isAnonymous: user.isAnonymous || false,
            email: user.email || null
        };

        return jwt.sign(payload, this.jwtSecret, { 
            expiresIn: '24h',
            issuer: 'fighter-game-server'
        });
    }

    // Verify custom JWT token
    verifyCustomToken(token) {
        try {
            const decoded = jwt.verify(token, this.jwtSecret);
            return {
                success: true,
                user: decoded
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Update user stats in Firestore
    async updateUserStats(uid, stats) {
        if (!this.isFirebaseAvailable) {
            console.warn('Firebase Admin not available - skipping stats update');
            return { success: false, error: 'Firebase not configured' };
        }

        try {
            const userRef = firestore.collection('users').doc(uid);
            await userRef.update({
                ...stats,
                lastActive: admin.firestore.FieldValue.serverTimestamp()
            });

            return { success: true };
        } catch (error) {
            console.error('Stats update error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Get user data from Firestore
    async getUserData(uid) {
        if (!this.isFirebaseAvailable) {
            console.warn('Firebase Admin not available - returning null user data');
            return { success: false, error: 'Firebase not configured' };
        }

        try {
            const userDoc = await firestore.collection('users').doc(uid).get();
            
            if (!userDoc.exists) {
                return {
                    success: false,
                    error: 'User not found'
                };
            }

            return {
                success: true,
                userData: userDoc.data()
            };
        } catch (error) {
            console.error('Get user data error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Check if username is available
    async isUsernameAvailable(username) {
        if (!this.isFirebaseAvailable) {
            console.warn('Firebase Admin not available - assuming username available');
            return { success: true, available: true };
        }

        try {
            const usernameDoc = await firestore.collection('usernames').doc(username.toLowerCase()).get();
            
            return {
                success: true,
                available: !usernameDoc.exists
            };
        } catch (error) {
            console.error('Username check error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Save match result to Firestore
    async saveMatchResult(matchData) {
        if (!this.isFirebaseAvailable) {
            console.warn('Firebase Admin not available - skipping match save');
            return { success: false, error: 'Firebase not configured' };
        }

        try {
            const matchRef = firestore.collection('matches').doc();
            await matchRef.set({
                ...matchData,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return { 
                success: true,
                matchId: matchRef.id
            };
        } catch (error) {
            console.error('Match save error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Check if Firebase is properly configured
    isConfigured() {
        return this.isFirebaseAvailable;
    }
}

// Create and export server auth manager instance
const serverAuthManager = new ServerAuthManager();

// Middleware for Socket.IO authentication
const socketAuthMiddleware = async (socket, next) => {
    try {
        const token = socket.handshake.auth?.token;
        
        if (!token) {
            // Allow unauthenticated connections for guest play
            socket.user = null;
            return next();
        }

        // Try to verify as Firebase ID token first
        const firebaseResult = await serverAuthManager.verifyIdToken(token);
        if (firebaseResult.success) {
            socket.user = firebaseResult.user;
            socket.customToken = serverAuthManager.createCustomToken(firebaseResult.user);
            return next();
        }

        // If Firebase verification fails, try custom JWT
        const customResult = serverAuthManager.verifyCustomToken(token);
        if (customResult.success) {
            socket.user = customResult.user;
            return next();
        }

        // If both fail, allow connection but mark as unauthenticated
        socket.user = null;
        next();
    } catch (error) {
        console.error('Socket auth middleware error:', error);
        socket.user = null;
        next();
    }
};

module.exports = {
    serverAuthManager,
    socketAuthMiddleware,
    admin,
    auth,
    firestore
}; 