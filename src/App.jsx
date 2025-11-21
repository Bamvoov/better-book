import React, { useState, useEffect, useMemo } from 'react';
import { getAnalytics } from "firebase/analytics";
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  signInWithCustomToken, 
  onAuthStateChanged,
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  addDoc, 
  setDoc, 
  deleteDoc, 
  onSnapshot, 
  collection, 
  query,
  serverTimestamp,
  setLogLevel as setFirestoreLogLevel
} from 'firebase/firestore';

// --- Firebase Configuration ---
// These global variables are provided by the environment.
// --- Firebase Configuration ---
const appId = 'betterbooks'; // We set this manually for local testing
const initialAuthToken = null;     // We set this to null for local testing

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDb_6npqmEXBMNiVybAN-X4xsUzIM480AI",
  authDomain: "betterbooks-6338d.firebaseapp.com",
  projectId: "betterbooks-6338d",
  storageBucket: "betterbooks-6338d.firebasestorage.app",
  messagingSenderId: "365980192193",
  appId: "1:365980192193:web:bc670b0a13098cf3b13340"
};

// Initialize Firebase
// const app = initializeApp(firebaseConfig); // This line is already below in the file



// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);

// Enable debug logging for Firebase
setFirestoreLogLevel('debug');

// --- Helper Functions ---

/**
 * Formats a Firestore timestamp into a readable date/time string.
 * @param {object | null} timestamp - The Firestore timestamp object.
 * @returns {string} - A formatted string (e.g., "Oct 21, 8:30 PM") or 'Just now'.
 */
const formatTimestamp = (timestamp) => {
  if (!timestamp) return 'Just now';
  try {
    const date = timestamp.toDate();
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch (error) {
    console.error("Error formatting timestamp:", error);
    return 'Invalid date';
  }
};

/**
 * A helper function to pause execution, used for exponential backoff.
 * @param {number} ms - The number of milliseconds to sleep.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calls the Gemini API with exponential backoff.
 * @param {string} userQuery - The user's prompt.
 * @param {string} systemInstruction - The system prompt to guide the model.
 * @param {number} retries - The maximum number of retries.
 * @param {number} delay - The initial delay in ms.
 * @returns {Promise<string>} - The text response from the model.
 */
const callGemini = async (userQuery, systemInstruction, retries = 3, delay = 1000) => {
  const apiKey =  import.meta.env.VITE_GEMINI_API_KEY; // Per instructions, this is populated by the environment
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: userQuery }] }],
    ...(systemInstruction && { 
      systemInstruction: { parts: [{ text: systemInstruction }] } 
    }),
  };

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          // Throttling or server error, wait and retry
          console.warn(`Gemini API error ${response.status}, retrying...`);
          throw new Error(`API Error: ${response.status}`);
        }
        // Don't retry on client errors like 400
        const errorData = await response.json();
        throw new Error(`API Error ${response.status}: ${errorData.error?.message || 'Bad request'}`);
      }

      const result = await response.json();
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text;

      if (text) {
        return text;
      } else {
        throw new Error("No content returned from API.");
      }

    } catch (error) {
      console.error(`Gemini call attempt ${i + 1} failed:`, error.message);
      if (i === retries - 1) {
        // Last retry failed
        throw error;
      }
      // Wait before retrying with exponential backoff
      await sleep(delay * Math.pow(2, i));
    }
  }
  throw new Error("Gemini API call failed after all retries.");
};


// --- React Components ---

/**
 * A reusable button component.
 */
const Button = ({ onClick, children, className = '', variant = 'primary', disabled = false }) => {
  const baseStyle = 'w-full md:w-auto px-4 py-2 rounded-lg font-semibold transition-all duration-200 shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2';
  const variants = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500',
    secondary: 'bg-gray-200 text-gray-800 hover:bg-gray-300 focus:ring-gray-400',
    danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
  };
  return (
    <button 
      onClick={onClick} 
      className={`${baseStyle} ${variants[variant]} ${className} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      disabled={disabled}
    >
      {children}
    </button>
  );
};

/**
 * A modal dialog component.
 */
const Modal = ({ title, children, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm">
      <div className="bg-white rounded-lg shadow-xl w-11/12 max-w-md m-4">
        <div className="flex justify-between items-center p-4 border-b">
          <h3 className="text-xl font-semibold">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
        </div>
        <div className="p-4">
          {children}
        </div>
      </div>
    </div>
  );
};

/**
 * The main sidebar component for listing notes.
 */
const NoteList = ({ notes, selectedNote, onSelectNote, onNewNote, userId }) => {
  return (
    <div className="h-full bg-gray-50 border-r border-gray-200 flex flex-col">
      <div className="p-4 border-b">
        <h2 className="text-xl font-bold text-gray-800">My Notes</h2>
        <p className="text-sm text-gray-500 truncate" title={`User ID: ${userId}`}>
          User ID: {userId}
        </p>
      </div>
      <div className="flex-grow overflow-y-auto">
        {notes.length === 0 && (
          <p className="p-4 text-gray-500">No notes yet. Create one!</p>
        )}
        <ul>
          {notes.map(note => (
            <li key={note.id}>
              <button
                onClick={() => onSelectNote(note)}
                className={`w-full text-left p-4 border-b border-gray-100 hover:bg-blue-50 focus:outline-none ${selectedNote?.id === note.id ? 'bg-blue-100' : ''}`}
              >
                <h3 className="font-semibold text-gray-900 truncate">{note.title || 'Untitled'}</h3>
                <p className="text-sm text-gray-600 truncate">{note.content ? note.content.substring(0, 40) + '...' : 'No content'}</p>
                <span className="text-xs text-gray-400">{formatTimestamp(note.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="p-4 border-t bg-white">
        <Button onClick={onNewNote} variant="primary">
          + New Note
        </Button>
      </div>
    </div>
  );
};

/**
 * The main editor component for creating/editing a note.
 */
const NoteEditor = ({ selectedNote, onSave, onDelete, onBack, isSaving }) => {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  // --- Gemini AI State ---
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [isLoadingExpand, setIsLoadingExpand] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [summaryResult, setSummaryResult] = useState(null);
  // -------------------------

  // When the selected note changes, update the editor's state
  useEffect(() => {
    if (selectedNote) {
      setTitle(selectedNote.title || '');
      setContent(selectedNote.content || '');
    } else {
      setTitle('');
      setContent('');
    }
  }, [selectedNote]);

  const handleSave = () => {
    onSave({
      ...selectedNote,
      title: title,
      content: content,
    });
  };

  const handleDeleteConfirm = () => {
    if (selectedNote && selectedNote.id) {
      onDelete(selectedNote.id);
    }
    setShowDeleteModal(false);
  };

  // --- Gemini Feature Handlers ---

  const handleSummarize = async () => {
    if (!content) {
      setAiError("Cannot summarize an empty note.");
      return;
    }
    setIsLoadingSummary(true);
    setAiError(null);
    try {
      const systemPrompt = "You are a helpful assistant. Summarize the following note in one or two concise sentences.";
      const userQuery = content;
      const summary = await callGemini(userQuery, systemPrompt);
      setSummaryResult(summary);
    } catch (error) {
      console.error("Error summarizing:", error);
      setAiError("Failed to generate summary. Please try again.");
    } finally {
      setIsLoadingSummary(false);
    }
  };

  const handleExpand = async () => {
    const textToExpand = content || title;
    if (!textToExpand) {
      setAiError("Cannot expand on an empty note. Try adding a title.");
      return;
    }
    setIsLoadingExpand(true);
    setAiError(null);
    try {
      const systemPrompt = "You are a helpful writing assistant. Continue writing based on the text provided, adding one or two new paragraphs that expand on the ideas. Respond only with the new text.";
      const userQuery = `Current note:\nTitle: ${title}\nContent: ${content}`;
      const expansion = await callGemini(userQuery, systemPrompt);
      setContent(prev => (prev ? prev + "\n\n" : "") + expansion);
    } catch (error) {
      console.error("Error expanding:", error);
      setAiError("Failed to expand text. Please try again.");
    } finally {
      setIsLoadingExpand(false);
    }
  };

  const isAiLoading = isLoadingSummary || isLoadingExpand;
  // -------------------------------

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header bar */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between space-x-2 flex-wrap">
          {/* Back button (mobile only) */}
          <button
            onClick={onBack}
            className="text-blue-600 hover:text-blue-800 md:hidden flex-shrink-0"
            disabled={isAiLoading || isSaving}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          
          <div className="flex-grow min-w-[200px] my-1">
            <input
              type="text"
              placeholder="Note Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full text-xl font-bold p-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isAiLoading || isSaving}
            />
          </div>
          
          <div className="flex space-x-2 my-1 flex-shrink-0">
            <Button 
              onClick={handleSummarize} 
              className="!w-auto bg-purple-600 text-white hover:bg-purple-700 focus:ring-purple-500"
              disabled={isAiLoading || isSaving || !content}
              title="Generate a summary of this note"
            >
              {isLoadingSummary ? 'Summarizing...' : '✨ Summarize'}
            </Button>
            <Button 
              onClick={handleExpand} 
              className="!w-auto bg-green-600 text-white hover:bg-green-700 focus:ring-green-500"
              disabled={isAiLoading || isSaving || (!content && !title)}
              title="Expand on the ideas in this note"
            >
              {isLoadingExpand ? 'Expanding...' : '✨ Expand'}
            </Button>

            {selectedNote && selectedNote.id && (
              <Button 
                onClick={() => setShowDeleteModal(true)} 
                variant="danger" 
                className="!w-auto px-3"
                disabled={isAiLoading || isSaving}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" />
                </svg>
              </Button>
            )}
            <Button 
              onClick={handleSave} 
              variant="primary" 
              className="!w-auto"
              disabled={isAiLoading || isSaving}
            >
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
        {/* AI Error Message */}
        {aiError && (
          <p className="text-red-600 text-sm mt-2 text-center">{aiError}</p>
        )}
      </div>

      {/* Text area */}
      <textarea
        placeholder="Start writing your note here..."
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className={`flex-grow w-full p-6 text-gray-800 text-lg leading-7 resize-none focus:outline-none ${isAiLoading ? 'opacity-75 bg-gray-50' : ''}`}
        readOnly={isAiLoading}
      />

      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <Modal title="Delete Note" onClose={() => setShowDeleteModal(false)}>
          <p className="text-gray-700 mb-6">Are you sure you want to delete this note permanently?</p>
          <div className="flex justify-end space-x-3">
            <Button variant="secondary" onClick={() => setShowDeleteModal(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDeleteConfirm}>
              Delete
            </Button>
          </div>
        </Modal>
      )}

      {/* Summary Modal */}
      {summaryResult && (
        <Modal title="✨ Note Summary" onClose={() => setSummaryResult(null)}>
          <p className="text-gray-700 mb-6 whitespace-pre-wrap">{summaryResult}</p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setSummaryResult(null)}>
              Close
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
};

/**
 * The main App component.
 */
export default function App() {
  const [userId, setUserId] = useState(null);
  const [notes, setNotes] = useState([]);
  const [selectedNote, setSelectedNote] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);
  
  // 'list' or 'editor' - for mobile view switching
  const [view, setView] = useState('list');

  // Authenticate user on load
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        console.log("User is signed in with UID:", user.uid);
        setUserId(user.uid);
      } else {
        console.log("No user signed in, attempting sign-in...");
        try {
          if (initialAuthToken) {
            console.log("Signing in with custom token...");
            await signInWithCustomToken(auth, initialAuthToken);
          } else {
            console.warn("No custom token, signing in anonymously...");
            await signInAnonymously(auth);
          }
        } catch (authError) {
          console.error("Error signing in:", authError);
          setError("Could not authenticate. Please refresh.");
        }
      }
    });
    return () => unsubscribe();
  }, []);

  // Subscribe to notes collection when userId is available
  useEffect(() => {
    if (!userId) {
      console.log("No user ID, skipping notes subscription.");
      return;
    }

    console.log(`Subscribing to notes for user: ${userId}`);
    const notesCollectionPath = `/artifacts/${appId}/users/${userId}/notes`;
    const q = query(collection(db, notesCollectionPath));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      console.log("Received notes snapshot.");
      const notesData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));
      
      // Sort notes by creation date (newest first) on the client
      // We sort on the client to avoid needing a composite index in Firestore
      notesData.sort((a, b) => {
        const dateA = a.createdAt ? a.createdAt.toMillis() : 0;
        const dateB = b.createdAt ? b.createdAt.toMillis() : 0;
        return dateB - dateA;
      });
      
      setNotes(notesData);
    }, (err) => {
      console.error("Error listening to notes:", err);
      setError("Could not load notes.");
    });

    // Cleanup subscription on component unmount
    return () => {
      console.log("Unsubscribing from notes.");
      unsubscribe();
    };
  }, [userId]); // Dependency on userId

  // --- Event Handlers ---

  const handleSelectNote = (note) => {
    setSelectedNote(note);
    setView('editor');
  };

  const handleNewNote = () => {
    setSelectedNote(null);
    setView('editor');
  };

  const handleBackToList = () => {
    setView('list');
  };

  const handleSaveNote = async (noteToSave) => {
    if (!userId) {
      setError("You must be signed in to save notes.");
      return;
    }
    if (isSaving) return;

    setIsSaving(true);
    const notesCollectionPath = `/artifacts/${appId}/users/${userId}/notes`;

    try {
      if (noteToSave.id) {
        // Update existing note
        console.log(`Updating note: ${noteToSave.id}`);
        const noteRef = doc(db, notesCollectionPath, noteToSave.id);
        await setDoc(noteRef, {
          ...noteToSave,
          updatedAt: serverTimestamp(),
        }, { merge: true });
        setSelectedNote(noteToSave); // Keep the updated note selected
      } else {
        // Create new note
        console.log("Creating new note...");
        const newDocRef = await addDoc(collection(db, notesCollectionPath), {
          title: noteToSave.title,
          content: noteToSave.content,
          createdAt: serverTimestamp(),
        });
        // Select the newly created note
        setSelectedNote({ ...noteToSave, id: newDocRef.id, createdAt: new Date() });
      }
      setView('editor'); // Stay in editor view
    } catch (err) {
      console.error("Error saving note:", err);
      setError("Failed to save note.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteNote = async (noteId) => {
    if (!userId) {
      setError("You must be signed in to delete notes.");
      return;
    }

    console.log(`Deleting note: ${noteId}`);
    try {
      const noteRef = doc(db, `/artifacts/${appId}/users/${userId}/notes`, noteId);
      await deleteDoc(noteRef);
      setSelectedNote(null);
      setView('list'); // Go back to list after delete
    } catch (err)
 {
      console.error("Error deleting note:", err);
      setError("Failed to delete note.");
    }
  };

  // --- Render ---

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-red-50">
        <div className="p-6 bg-white rounded-lg shadow-md text-red-700">
          <h2 className="font-bold text-xl mb-2">An Error Occurred</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100">
        <p className="text-lg text-gray-600">Authenticating...</p>
      </div>
    );
  }

  return (
    <div className="font-inter h-screen w-screen overflow-hidden flex text-gray-900">
      {/* Tailwind CSS Responsive Layout:
        - Mobile: `view` state controls showing list or editor.
        - Tablet/Desktop (md+): Show both side-by-side.
      */}

      {/* Note List (Sidebar) */}
      <div className={`
        w-full h-full md:w-1/3 md:max-w-sm flex-shrink-0
        ${view === 'list' ? 'block' : 'hidden'} md:block
      `}>
        <NoteList
          notes={notes}
          selectedNote={selectedNote}
          onSelectNote={handleSelectNote}
          onNewNote={handleNewNote}
          userId={userId}
        />
      </div>

      {/* Note Editor (Main Content) */}
      <div className={`
        w-full h-full flex-grow
        ${view === 'editor' ? 'block' : 'hidden'} md:block
      `}>
        <NoteEditor
          selectedNote={selectedNote}
          onSave={handleSaveNote}
          onDelete={handleDeleteNote}
          onBack={handleBackToList}
          isSaving={isSaving}
        />
      </div>
    </div>
  );
}


