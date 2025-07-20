// Firebase Configuration for Client-Side Authentication
// This file handles Firebase initialization and auth providers

// Using Firebase compat SDK (loaded via CDN)

// Environment-based logging for client-side
const isDevelopment = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const clientLog = {
    info: (...args) => isDevelopment && console.log('[CLIENT-INFO]', ...args),
    warn: (...args) => isDevelopment && console.warn('[CLIENT-WARN]', ...args),
    error: (...args) => console.error('[CLIENT-ERROR]', ...args), // Always log errors
    debug: (...args) => isDevelopment && console.log('[CLIENT-DEBUG]', ...args)
};

// Firebase configuration object
// These values should be replaced with your actual Firebase project config
// They are safe to expose in client-side code as they identify your Firebase project
const firebaseConfig = {
    apiKey: window.FIREBASE_CONFIG?.apiKey || "your_firebase_api_key_here",
    authDomain: window.FIREBASE_CONFIG?.authDomain || "your-project-id.firebaseapp.com", 
    projectId: window.FIREBASE_CONFIG?.projectId || "your-project-id",
    storageBucket: window.FIREBASE_CONFIG?.storageBucket || "your-project-id.appspot.com",
    messagingSenderId: window.FIREBASE_CONFIG?.messagingSenderId || "your_sender_id_here",
    appId: window.FIREBASE_CONFIG?.appId || "your_app_id_here"
};

// Validate Firebase configuration
if (firebaseConfig.apiKey === "your_firebase_api_key_here") {
    clientLog.error("Firebase configuration not set. Please update firebase-config.js with your Firebase project details.");
}

// Initialize Firebase (compat SDK)
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Authentication state management
class AuthManager {
    constructor() {
        this.currentUser = null;
        this.authStateListeners = [];
        this.isInitialized = false;
        
        // Listen for authentication state changes
        auth.onAuthStateChanged((user) => {
            this.currentUser = user;
            this.notifyAuthStateChange(user);
        });
    }

    // Add listener for auth state changes
    addAuthStateListener(callback) {
        this.authStateListeners.push(callback);
    }

    // Remove auth state listener
    removeAuthStateListener(callback) {
        this.authStateListeners = this.authStateListeners.filter(cb => cb !== callback);
    }

    // Notify all listeners of auth state change
    notifyAuthStateChange(user) {
        this.authStateListeners.forEach(callback => callback(user));
    }

    // Guest authentication (anonymous)
    async signInAsGuest(displayName) {
        try {
            const userCredential = await auth.signInAnonymously();
            const user = userCredential.user;
            
            // Update profile with display name
            await user.updateProfile({ displayName: displayName });
            
            // Store guest user data in Firestore
            await db.collection('users').doc(user.uid).set({
                displayName: displayName,
                isGuest: true,
                isAnonymous: true,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                lastActive: firebase.firestore.FieldValue.serverTimestamp(),
                gamesPlayed: 0,
                wins: 0,
                losses: 0
            });

            // Store in localStorage for persistence
            localStorage.setItem('guestDisplayName', displayName);
            localStorage.setItem('guestUserId', user.uid);
            
            clientLog.info('Guest authentication successful:', user.uid);
            return {
                success: true,
                user: {
                    uid: user.uid,
                    displayName: displayName,
                    isGuest: true,
                    isAnonymous: true
                }
            };
        } catch (error) {
            clientLog.error('Guest authentication error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Registered user authentication
    async signInWithEmail(email, password) {
        try {
            const userCredential = await auth.signInWithEmailAndPassword(email, password);
            const user = userCredential.user;
            
            // Update last active timestamp
            await db.collection('users').doc(user.uid).update({
                lastActive: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            clientLog.info('Email authentication successful:', user.uid);
            return {
                success: true,
                user: {
                    uid: user.uid,
                    email: user.email,
                    displayName: user.displayName,
                    isGuest: false,
                    isAnonymous: false
                }
            };
        } catch (error) {
            clientLog.error('Email authentication error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Register new user with email and password
    async registerWithEmail(email, password, username) {
        try {
            // Check if username is available (simplified - would need proper validation)
            const usernameDoc = await db.collection('usernames').doc(username.toLowerCase()).get();
            if (usernameDoc.exists) {
                return {
                    success: false,
                    error: 'Username already taken'
                };
            }

            const userCredential = await auth.createUserWithEmailAndPassword(email, password);
            const user = userCredential.user;
            
            // Update profile with username
            await user.updateProfile({ displayName: username });
            
            // Store user data in Firestore
            await db.collection('users').doc(user.uid).set({
                username: username,
                email: email,
                displayName: username,
                isGuest: false,
                isAnonymous: false,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                lastActive: firebase.firestore.FieldValue.serverTimestamp(),
                gamesPlayed: 0,
                wins: 0,
                losses: 0,
                level: 1,
                xp: 0
            });

            // Reserve username
            await db.collection('usernames').doc(username.toLowerCase()).set({
                uid: user.uid,
                username: username,
                reservedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            
            clientLog.info('Registration successful:', user.uid);
            return {
                success: true,
                user: {
                    uid: user.uid,
                    email: user.email,
                    displayName: username,
                    isGuest: false,
                    isAnonymous: false
                }
            };
        } catch (error) {
            clientLog.error('Registration error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Sign out current user
    async signOutUser() {
        try {
            await auth.signOut();
            
            // Clear guest data from localStorage
            localStorage.removeItem('guestDisplayName');
            localStorage.removeItem('guestUserId');
            
            clientLog.info('User signed out successfully');
            return { success: true };
        } catch (error) {
            clientLog.error('Sign out error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // Get current user state
    getCurrentUser() {
        return this.currentUser;
    }

    // Check if user is authenticated
    isAuthenticated() {
        return this.currentUser !== null;
    }

    // Check if current user is guest
    isGuest() {
        return this.currentUser && this.currentUser.isAnonymous;
    }

    // Get user display name
    getDisplayName() {
        if (this.currentUser) {
            return this.currentUser.displayName || 'Anonymous User';
        }
        return null;
    }

    // Claim account for guest user (upgrade anonymous to registered)
    async claimAccount(email, password, username) {
        if (!this.currentUser || !this.currentUser.isAnonymous) {
            return {
                success: false,
                error: 'No guest user to claim'
            };
        }

        try {
            // This is a simplified approach - in production you'd need Firebase Auth linking
            // For now, we'll create a new account and transfer data
            const registerResult = await this.registerWithEmail(email, password, username);
            
            if (registerResult.success) {
                // Transfer guest progress to new account (simplified)
                const guestData = await db.collection('users').doc(this.currentUser.uid).get();
                if (guestData.exists) {
                    const guestStats = guestData.data();
                    await db.collection('users').doc(registerResult.user.uid).update({
                        gamesPlayed: guestStats.gamesPlayed || 0,
                        wins: guestStats.wins || 0,
                        losses: guestStats.losses || 0
                    });
                }
                
                // Clean up guest data
                localStorage.removeItem('guestDisplayName');
                localStorage.removeItem('guestUserId');
                
                clientLog.info('Account claimed successfully');
                return {
                    success: true,
                    message: 'Account claimed successfully! Your progress has been saved.'
                };
            }
            
            return registerResult;
        } catch (error) {
            clientLog.error('Account claiming error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Create global auth manager instance
const authManager = new AuthManager();

// Export for use in other scripts (global variables)
window.AuthManager = authManager;
window.firebaseAuth = auth;
window.firebaseDb = db; 