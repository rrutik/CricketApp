import React, { useState, useEffect } from 'react';
import { RotateCcw, RotateCw, Trophy, Play, ChevronRight, User, LogIn, LogOut, Sparkles, ShieldCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, googleProvider } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, addDoc, query, where, orderBy, onSnapshot, limit, serverTimestamp, doc, setDoc, getDoc } from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDoc(doc(db, 'test', 'connection'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration. ");
    }
  }
}
testConnection();

type Ball = {
  runs: number;
  extras: number;
  isWicket: boolean;
  isLegal: boolean;
  label: string;
};

type MatchRecord = {
  id: string;
  date: string;
  teamA: string;
  teamB: string;
  totalOvers: number;
  innings1: { runs: number; wickets: number; balls: number; team: string };
  innings2?: { runs: number; wickets: number; balls: number; team: string };
  winner?: string;
  resultMessage?: string;
};

type AppView = 'login' | 'role_select' | 'dashboard' | 'setup' | 'match' | 'viewer_setup' | 'viewer_match';

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userType, setUserType] = useState<'guest' | 'user' | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<AppView>('login');
  const [matchHistory, setMatchHistory] = useState<MatchRecord[]>([]);
  
  const [role, setRole] = useState<'scorer' | 'viewer' | null>(null);
  const [viewerScorerId, setViewerScorerId] = useState('');
  const [liveMatchData, setLiveMatchData] = useState<any>(null);

  const [teamA, setTeamA] = useState('Team A');
  const [teamB, setTeamB] = useState('Team B');
  const [totalOvers, setTotalOvers] = useState<number | ''>(5);
  const [tossWinner, setTossWinner] = useState<1 | 2>(1);
  const [optedTo, setOptedTo] = useState<'bat' | 'bowl'>('bat');
  
  const [isMatchStarted, setIsMatchStarted] = useState(false);
  const [isMatchOver, setIsMatchOver] = useState(false);
  
  const [currentInnings, setCurrentInnings] = useState<1 | 2>(1);
  const [battingTeam, setBattingTeam] = useState<1 | 2>(1);
  
  const [runs, setRuns] = useState(0);
  const [wickets, setWickets] = useState(0);
  const [balls, setBalls] = useState(0);
  const [history, setHistory] = useState<Ball[]>([]);
  const [redoStack, setRedoStack] = useState<Ball[]>([]);
  
  const [firstInningsScore, setFirstInningsScore] = useState<{runs: number, wickets: number, balls: number, team: string} | null>(null);
  const [isNbMode, setIsNbMode] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editingBallIndex, setEditingBallIndex] = useState<number | null>(null);
  const [editRuns, setEditRuns] = useState(0);
  const [editIsWicket, setEditIsWicket] = useState(false);
  const [editExtraType, setEditExtraType] = useState<'none' | 'wd' | 'nb'>('none');

  // Persistence Logic
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setUserId(user.uid);
        setUserType('user');
        setIsLoggedIn(true);
        const savedState = localStorage.getItem('cricscore_current_match');
        if (savedState) {
          const state = JSON.parse(savedState);
          if (state.isMatchStarted && !state.isMatchOver) {
            setCurrentView('match');
            setRole('scorer');
            return;
          }
        }
        setCurrentView((prev) => prev === 'login' ? 'role_select' : prev);
      } else {
        setUserId(null);
        // Only reset to login if they were a logged-in user, not a guest
        setUserType((prevType) => {
          if (prevType === 'user') {
            setIsLoggedIn(false);
            setRole(null);
            setCurrentView('login');
            return null;
          }
          return prevType;
        });
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (userId) {
      const q = query(
        collection(db, 'matches'),
        where('uid', '==', userId),
        orderBy('createdAt', 'desc'),
        limit(10)
      );
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const matches: MatchRecord[] = [];
        snapshot.forEach((doc) => {
          matches.push({ id: doc.id, ...doc.data() } as MatchRecord);
        });
        setMatchHistory(matches);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'matches');
      });
      return () => unsubscribe();
    } else {
      const savedHistory = localStorage.getItem('cricscore_history');
      if (savedHistory) setMatchHistory(JSON.parse(savedHistory));
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      localStorage.setItem('cricscore_history', JSON.stringify(matchHistory));
    }
  }, [matchHistory, userId]);

  useEffect(() => {
    const savedState = localStorage.getItem('cricscore_current_match');
    if (savedState) {
      const state = JSON.parse(savedState);
      setTeamA(state.teamA);
      setTeamB(state.teamB);
      setTotalOvers(state.totalOvers);
      setTossWinner(state.tossWinner);
      setOptedTo(state.optedTo);
      setIsMatchStarted(state.isMatchStarted);
      setIsMatchOver(state.isMatchOver);
      setCurrentInnings(state.currentInnings);
      setBattingTeam(state.battingTeam);
      setRuns(state.runs);
      setWickets(state.wickets);
      setBalls(state.balls);
      setHistory(state.history);
      if (state.redoStack) setRedoStack(state.redoStack);
      setFirstInningsScore(state.firstInningsScore);
      if (state.isMatchStarted && !state.isMatchOver) {
        setCurrentView('match');
      }
    }
  }, []);

  useEffect(() => {
    if (isMatchStarted) {
      const state = {
        teamA, teamB, totalOvers, tossWinner, optedTo,
        isMatchStarted, isMatchOver, currentInnings, battingTeam,
        runs, wickets, balls, history, redoStack, firstInningsScore
      };
      localStorage.setItem('cricscore_current_match', JSON.stringify(state));
      
      if (role === 'scorer' && userId) {
        setDoc(doc(db, 'live_matches', userId), state).catch(err => {
          handleFirestoreError(err, OperationType.WRITE, `live_matches/${userId}`);
        });
      }
    } else {
      localStorage.removeItem('cricscore_current_match');
      if (role === 'scorer' && userId) {
        // We could delete the live match or leave it. Leaving it is fine, or we can clear it.
        // Let's clear it when match is not started.
        // Actually, maybe we shouldn't delete it immediately, but it's fine.
      }
    }
  }, [isMatchStarted, isMatchOver, runs, wickets, balls, history, redoStack, currentInnings, battingTeam, teamA, teamB, totalOvers, tossWinner, optedTo, firstInningsScore, role, userId]);

  useEffect(() => {
    if (currentView === 'viewer_match' && viewerScorerId) {
      const unsubscribe = onSnapshot(doc(db, 'live_matches', viewerScorerId), (docSnap) => {
        if (docSnap.exists()) {
          setLiveMatchData(docSnap.data());
        } else {
          setLiveMatchData(null);
        }
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, `live_matches/${viewerScorerId}`);
        setLiveMatchData(null);
      });
      return () => unsubscribe();
    }
  }, [currentView, viewerScorerId]);

  const timelineRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (timelineRef.current) {
      // Smooth scroll to the end when a new ball is added
      timelineRef.current.scrollTo({
        left: timelineRef.current.scrollWidth,
        behavior: 'smooth'
      });
    }
  }, [history.length]);

  const saveMatchToHistory = async () => {
    if (!firstInningsScore) return;
    
    const resultMessage = runs > firstInningsScore.runs 
      ? `${getBattingTeamName()} Won by ${10 - wickets} wickets!` 
      : runs === firstInningsScore.runs 
        ? "Match Tied!" 
        : `${getBowlingTeamName()} Won by ${firstInningsScore.runs - runs} runs!`;

    const newRecord = {
      date: new Date().toLocaleDateString(),
      teamA,
      teamB,
      totalOvers,
      innings1: firstInningsScore,
      innings2: { runs, wickets, balls, team: getBattingTeamName() },
      winner: runs > firstInningsScore.runs ? getBattingTeamName() : (runs === firstInningsScore.runs ? 'Tie' : getBowlingTeamName()),
      resultMessage
    };

    if (userId) {
      try {
        await addDoc(collection(db, 'matches'), {
          ...newRecord,
          uid: userId,
          createdAt: Date.now()
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, 'matches');
      }
    } else {
      const localRecord: MatchRecord = {
        ...newRecord,
        id: Date.now().toString()
      };
      setMatchHistory(prev => [localRecord, ...prev].slice(0, 10)); // Keep last 10
    }
  };

  const startMatch = () => {
    // Ensure totalOvers is a valid number before starting
    const finalOvers = totalOvers === '' || totalOvers < 1 ? 1 : totalOvers;
    setTotalOvers(finalOvers);

    // Reset match state for a new match
    setRuns(0);
    setWickets(0);
    setBalls(0);
    setHistory([]);
    setRedoStack([]);
    setCurrentInnings(1);
    setFirstInningsScore(null);
    setIsMatchOver(false);
    setIsNbMode(false);
    setShowHistory(false);
    setEditingBallIndex(null);

    if (optedTo === 'bat') {
      setBattingTeam(tossWinner);
    } else {
      setBattingTeam(tossWinner === 1 ? 2 : 1);
    }
    setIsMatchStarted(true);
    setCurrentView('match');
  };

  const addBall = (runsScored: number, isWicket: boolean, isLegal: boolean, label: string, extraRuns: number = 0, isRedo: boolean = false) => {
    if (wickets >= 10 || balls >= totalOvers * 6 || isMatchOver) return;
    
    if (!isRedo) {
      setRedoStack([]);
    }
    
    const totalRunsAdded = runsScored + extraRuns;
    const newRuns = runs + totalRunsAdded;
    const newWickets = wickets + (isWicket ? 1 : 0);
    const newBalls = balls + (isLegal ? 1 : 0);
    
    setRuns(newRuns);
    if (isWicket) setWickets(newWickets);
    if (isLegal) setBalls(newBalls);
    
    setHistory(h => [...h, { runs: runsScored, extras: extraRuns, isWicket, isLegal, label }]);
    
    // Check if target reached in 2nd innings
    if (currentInnings === 2 && firstInningsScore) {
      if (newRuns > firstInningsScore.runs) {
        setIsMatchOver(true);
      } else if (newWickets >= 10 || newBalls >= totalOvers * 6) {
        setIsMatchOver(true);
      }
    }
  };

  const undo = () => {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    setRedoStack(r => [...r, last]);
    setRuns(r => r - (last.runs + last.extras));
    if (last.isWicket) setWickets(w => w - 1);
    if (last.isLegal) setBalls(b => b - 1);
    setHistory(h => h.slice(0, -1));
    setIsNbMode(false);
    
    if (currentInnings === 2 && firstInningsScore) {
      const newRuns = runs - (last.runs + last.extras);
      const newWickets = wickets - (last.isWicket ? 1 : 0);
      const newBalls = balls - (last.isLegal ? 1 : 0);
      if (newRuns <= firstInningsScore.runs && newWickets < 10 && newBalls < totalOvers * 6) {
        setIsMatchOver(false);
      }
    } else {
      setIsMatchOver(false);
    }
  };

  const redo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack(r => r.slice(0, -1));
    addBall(next.runs, next.isWicket, next.isLegal, next.label, next.extras, true);
  };

  const recalculateScore = (newHistory: Ball[]) => {
    let newRuns = 0;
    let newWickets = 0;
    let newBalls = 0;
    
    newHistory.forEach(ball => {
      newRuns += ball.runs + ball.extras;
      if (ball.isWicket) newWickets += 1;
      if (ball.isLegal) newBalls += 1;
    });
    
    setRuns(newRuns);
    setWickets(newWickets);
    setBalls(newBalls);
    setHistory(newHistory);
    setRedoStack([]);
    
    if (currentInnings === 2 && firstInningsScore) {
      if (newRuns > firstInningsScore.runs || newWickets >= 10 || newBalls >= totalOvers * 6) {
        setIsMatchOver(true);
      } else {
        setIsMatchOver(false);
      }
    } else {
      setIsMatchOver(false);
    }
  };

  const openEditModal = (index: number) => {
    const ball = history[index];
    setEditRuns(ball.runs);
    setEditIsWicket(ball.isWicket);
    if (!ball.isLegal) {
      if (ball.label.includes('NB')) setEditExtraType('nb');
      else if (ball.label.includes('Wd')) setEditExtraType('wd');
      else setEditExtraType('none');
    } else {
      setEditExtraType('none');
    }
    setEditingBallIndex(index);
  };

  const saveEditedBall = () => {
    if (editingBallIndex === null) return;
    
    const newHistory = [...history];
    const ball = { ...newHistory[editingBallIndex] };
    
    ball.runs = editRuns;
    ball.isWicket = editIsWicket;
    
    if (editExtraType === 'none') {
      ball.isLegal = true;
      ball.extras = 0;
      if (ball.isWicket) {
        ball.label = editRuns > 0 ? `W+${editRuns}` : 'W';
      } else {
        ball.label = editRuns.toString();
      }
    } else if (editExtraType === 'wd') {
      ball.isLegal = false;
      ball.extras = 1;
      let lbl = 'Wd';
      if (editRuns > 0) lbl += `+${editRuns}`;
      if (ball.isWicket) lbl = `W(${lbl})`;
      ball.label = lbl;
    } else if (editExtraType === 'nb') {
      ball.isLegal = false;
      ball.extras = 1;
      let lbl = 'NB';
      if (editRuns > 0) lbl += `+${editRuns}`;
      if (ball.isWicket) lbl = `W(${lbl})`;
      ball.label = lbl;
    }
    
    newHistory[editingBallIndex] = ball;
    recalculateScore(newHistory);
    setEditingBallIndex(null);
  };

  const endInnings = () => {
    if (currentInnings === 1) {
      setFirstInningsScore({
        runs,
        wickets,
        balls,
        team: battingTeam === 1 ? teamA : teamB
      });
      setRuns(0);
      setWickets(0);
      setBalls(0);
      setHistory([]);
      setRedoStack([]);
      setCurrentInnings(2);
      setBattingTeam(battingTeam === 1 ? 2 : 1);
    } else {
      setIsMatchOver(true);
      saveMatchToHistory();
    }
  };

  const resetMatch = () => {
    setIsMatchStarted(false);
    setIsMatchOver(false);
    setCurrentInnings(1);
    setRuns(0);
    setWickets(0);
    setBalls(0);
    setHistory([]);
    setRedoStack([]);
    setFirstInningsScore(null);
    setIsNbMode(false);
    setShowHistory(false);
    setEditingBallIndex(null);
    setCurrentView('dashboard');
    localStorage.removeItem('cricscore_current_match');
  };

  const handleRunClick = (r: number) => {
    if (isNbMode) {
      addBall(r, false, false, r > 0 ? `NB+${r}` : 'NB', 1);
    } else {
      addBall(r, false, true, r.toString());
    }
    setIsNbMode(false);
  };

  const handleWicketClick = () => {
    if (isNbMode) {
      addBall(0, true, false, 'W(NB)', 1);
    } else {
      addBall(0, true, true, 'W');
    }
    setIsNbMode(false);
  };

  const formatOvers = (totalBalls: number) => {
    const overs = Math.floor(totalBalls / 6);
    const remainingBalls = totalBalls % 6;
    return `${overs}.${remainingBalls}`;
  };

  const getBattingTeamName = () => battingTeam === 1 ? teamA : teamB;
  const getBowlingTeamName = () => battingTeam === 1 ? teamB : teamA;

  // Group history into overs to display timeline
  type TimelineBall = Ball & { isUndone?: boolean };
  const oversList: TimelineBall[][] = [[]];
  let legalBallsInCurrentOver = 0;
  
  const fullTimeline: TimelineBall[] = [
    ...history,
    ...[...redoStack].reverse().map(b => ({ ...b, isUndone: true }))
  ];

  fullTimeline.forEach(ball => {
    if (legalBallsInCurrentOver === 6) {
      oversList.push([]);
      legalBallsInCurrentOver = 0;
    }
    oversList[oversList.length - 1].push(ball);
    if (ball.isLegal) {
      legalBallsInCurrentOver++;
    }
  });
  
  if (legalBallsInCurrentOver === 6 && balls < totalOvers * 6 && wickets < 10 && !isMatchOver) {
    oversList.push([]);
  }
  
  const currentOver = oversList[oversList.length - 1] || [];

  // Group history into overs with original index for history view
  const oversWithIndex: { overNumber: number, balls: (Ball & { originalIndex: number })[] }[] = [];
  let currentOverBalls: (Ball & { originalIndex: number })[] = [];
  let legalCount = 0;

  history.forEach((ball, index) => {
    if (legalCount === 6) {
      oversWithIndex.push({ overNumber: oversWithIndex.length + 1, balls: currentOverBalls });
      currentOverBalls = [];
      legalCount = 0;
    }
    currentOverBalls.push({ ...ball, originalIndex: index });
    if (ball.isLegal) legalCount++;
  });
  if (currentOverBalls.length > 0) {
    oversWithIndex.push({ overNumber: oversWithIndex.length + 1, balls: currentOverBalls });
  }

  const handleLogin = async (type: 'guest' | 'user') => {
    if (type === 'user') {
      try {
        await signInWithPopup(auth, googleProvider);
      } catch (error: any) {
        if (error.code === 'auth/popup-closed-by-user') {
          // User closed the popup, ignore the error
          return;
        }
        console.error("Login failed:", error);
      }
    } else {
      setUserType('guest');
      setIsLoggedIn(true);
      const savedState = localStorage.getItem('cricscore_current_match');
      if (savedState) {
        const state = JSON.parse(savedState);
        if (state.isMatchStarted && !state.isMatchOver) {
          setCurrentView('match');
          setRole('scorer');
          return;
        }
      }
      setCurrentView((prev) => prev === 'login' ? 'role_select' : prev);
    }
  };

  const handleLogout = async () => {
    setRole(null);
    if (userType === 'user') {
      try {
        await signOut(auth);
      } catch (error) {
        console.error("Logout failed:", error);
      }
    } else {
      setIsLoggedIn(false);
      setUserType(null);
      setCurrentView('login');
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 font-sans text-zinc-900">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="w-full max-w-sm flex flex-col items-center"
        >
          <div className="w-16 h-16 mb-6 bg-zinc-50 rounded-2xl flex items-center justify-center border border-zinc-200 shadow-sm">
            <Trophy className="w-8 h-8 text-zinc-900" />
          </div>
          
          <h1 className="text-3xl font-bold tracking-tight mb-2 text-center">
            CricScore
          </h1>
          <p className="text-zinc-500 text-sm text-center mb-10">
            The minimal scoring companion.
          </p>

          <div className="w-full space-y-3">
            <button 
              onClick={() => handleLogin('guest')}
              className="w-full bg-zinc-900 text-white font-medium py-3 px-4 rounded-lg flex items-center justify-center gap-2 hover:bg-zinc-800 transition-colors active:scale-[0.98]"
            >
              <User className="w-4 h-4" />
              Continue as Guest
            </button>

            <button 
              onClick={() => handleLogin('user')}
              className="w-full bg-white text-zinc-900 font-medium py-3 px-4 rounded-lg flex items-center justify-center gap-2 border border-zinc-200 hover:bg-zinc-50 transition-colors active:scale-[0.98]"
            >
              <LogIn className="w-4 h-4" />
              Login with Google
            </button>
          </div>

          <div className="mt-12 flex items-center justify-center gap-2 text-zinc-400">
            <ShieldCheck className="w-4 h-4" />
            <span className="text-xs font-medium">Secure & Private</span>
          </div>
        </motion.div>
      </div>
    );
  }

  if (currentView === 'role_select') {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 font-sans text-zinc-900">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="w-full max-w-sm flex flex-col items-center"
        >
          <div className="w-16 h-16 bg-zinc-900 rounded-2xl flex items-center justify-center mb-8 shadow-xl shadow-zinc-200/50">
            <Trophy className="w-8 h-8 text-white" />
          </div>
          
          <h1 className="text-3xl font-bold tracking-tight mb-2 text-center">Choose Your Role</h1>
          <p className="text-zinc-500 text-center mb-10 text-sm">Are you scoring a match or viewing one?</p>
          
          <div className="w-full space-y-4">
            <button 
              onClick={() => {
                setRole('scorer');
                setCurrentView('dashboard');
              }}
              className="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-medium py-4 px-6 rounded-xl transition-all flex items-center justify-center gap-3 shadow-sm"
            >
              <ShieldCheck className="w-5 h-5" />
              I want to Score a Match
            </button>
            
            <button 
              onClick={() => {
                setRole('viewer');
                setCurrentView('viewer_setup');
              }}
              className="w-full bg-white hover:bg-zinc-50 text-zinc-900 border border-zinc-200 font-medium py-4 px-6 rounded-xl transition-all flex items-center justify-center gap-3 shadow-sm"
            >
              <User className="w-5 h-5" />
              I want to View a Match
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  if (currentView === 'dashboard') {
    return (
      <div className="min-h-screen bg-white flex flex-col font-sans text-zinc-900">
        <header className="px-6 py-8 flex justify-between items-center max-w-md mx-auto w-full">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-zinc-500 text-sm">Welcome back, {userType === 'guest' ? 'Guest' : 'User'}</p>
          </div>
          <button 
            onClick={handleLogout}
            className="w-10 h-10 bg-white rounded-lg border border-zinc-200 flex items-center justify-center text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 transition-colors active:scale-95"
            title="Log out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </header>

        <main className="flex-1 px-6 pb-6 space-y-6 max-w-md mx-auto w-full">
          {/* Scorer ID Banner */}
          {role === 'scorer' && (
            <div className="bg-zinc-50 border border-zinc-200 rounded-2xl p-5 flex flex-col items-center text-center">
              <h3 className="text-sm font-bold text-zinc-900 mb-1">Your Scorer ID</h3>
              {userId ? (
                <>
                  <p className="text-xs text-zinc-500 mb-3">Share this ID with viewers to let them watch your match live.</p>
                  <div className="bg-white border border-zinc-200 px-4 py-2 rounded-lg text-lg font-mono font-bold tracking-widest text-zinc-900 select-all">
                    {userId}
                  </div>
                </>
              ) : (
                <p className="text-xs text-zinc-500">
                  You are playing as a Guest. <button onClick={() => setCurrentView('login')} className="text-zinc-900 font-semibold hover:underline">Log in</button> to share your live score.
                </p>
              )}
            </div>
          )}

          {/* Create Match Banner */}
          <motion.div 
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            onClick={() => setCurrentView('setup')}
            className="bg-zinc-900 rounded-xl p-6 text-white shadow-sm cursor-pointer group relative overflow-hidden"
          >
            <div className="relative z-10">
              <div className="w-10 h-10 bg-zinc-800 rounded-lg flex items-center justify-center mb-4 border border-zinc-700">
                <Play className="w-5 h-5 fill-current" />
              </div>
              <h2 className="text-xl font-bold mb-1">Create New Match</h2>
              <p className="text-zinc-400 text-sm">Set up teams, overs and toss to begin scoring.</p>
            </div>
            <div className="absolute bottom-6 right-6">
              <ChevronRight className="w-6 h-6 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
            </div>
          </motion.div>

          {/* Resume Match (Conditional) */}
          {isMatchStarted && !isMatchOver && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={() => setCurrentView('match')}
              className="bg-white border border-zinc-200 rounded-xl p-5 shadow-sm hover:border-zinc-300 hover:bg-zinc-50 transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-zinc-100 rounded-lg flex items-center justify-center text-zinc-900 border border-zinc-200">
                    <RotateCcw className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-zinc-900">Resume Match</h3>
                    <p className="text-xs text-zinc-500 font-medium">{teamA} vs {teamB}</p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-zinc-900">{runs}/{wickets}</div>
                  <div className="text-xs text-zinc-500 font-medium">{formatOvers(balls)} Overs</div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Recent History */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-semibold text-lg tracking-tight">Recent Matches</h3>
              <span className="text-xs font-medium text-zinc-400">Last 3</span>
            </div>
            
            <div className="space-y-3">
              {matchHistory.slice(0, 3).map(match => (
                <div key={match.id} className="bg-white border border-zinc-200 rounded-xl p-4 shadow-sm hover:border-zinc-300 transition-colors">
                  <div className="flex justify-between items-center mb-3">
                    <div className="text-xs font-medium text-zinc-500">{match.date}</div>
                    <div className="text-[10px] font-medium text-zinc-600 bg-zinc-100 px-2 py-0.5 rounded-md">Finished</div>
                  </div>
                  <div className="flex justify-between items-center">
                    <div className="flex-1">
                      <div className="font-semibold text-zinc-900">{match.teamA}</div>
                      <div className="text-xs text-zinc-500">{match.innings1.runs}/{match.innings1.wickets} <span className="text-zinc-400">({formatOvers(match.innings1.balls)})</span></div>
                    </div>
                    <div className="px-4 text-xs font-medium text-zinc-300">VS</div>
                    <div className="flex-1 text-right">
                      <div className="font-semibold text-zinc-900">{match.teamB}</div>
                      <div className="text-xs text-zinc-500">{match.innings2?.runs}/{match.innings2?.wickets} <span className="text-zinc-400">({formatOvers(match.innings2?.balls || 0)})</span></div>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-zinc-100 text-center">
                    <p className="text-xs font-medium text-zinc-600">{match.resultMessage}</p>
                  </div>
                </div>
              ))}
              {matchHistory.length === 0 && (
                <div className="text-center py-10 bg-zinc-50 border border-dashed border-zinc-200 rounded-xl">
                  <Trophy className="w-8 h-8 text-zinc-300 mx-auto mb-3" />
                  <p className="text-sm font-medium text-zinc-500">No matches played yet</p>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (currentView === 'viewer_setup') {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 font-sans text-zinc-900">
        <div className="w-full max-w-md">
          <button 
            onClick={() => setCurrentView('role_select')}
            className="mb-8 flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-medium"
          >
            <ChevronRight className="w-4 h-4 rotate-180" />
            Back to Roles
          </button>
          
          <h2 className="text-3xl font-bold tracking-tight mb-2">View Live Match</h2>
          <p className="text-zinc-500 mb-8 text-sm">Enter the Scorer ID to view their live match.</p>
          
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-500">Scorer ID</label>
              <input 
                type="text" 
                value={viewerScorerId}
                onChange={(e) => setViewerScorerId(e.target.value)}
                placeholder="e.g. abc123xyz"
                className="w-full p-4 bg-zinc-50 border border-zinc-200 rounded-xl focus:ring-2 focus:ring-zinc-900 focus:border-transparent outline-none transition-all font-medium text-lg"
              />
            </div>
            
            <button 
              onClick={() => {
                if (viewerScorerId.trim()) {
                  setCurrentView('viewer_match');
                }
              }}
              disabled={!viewerScorerId.trim()}
              className="w-full bg-zinc-900 hover:bg-zinc-800 disabled:bg-zinc-200 disabled:text-zinc-400 text-white font-medium py-4 px-6 rounded-xl transition-all flex items-center justify-center gap-2 shadow-sm"
            >
              <Play className="w-5 h-5" />
              Watch Live
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (currentView === 'setup') {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 font-sans text-zinc-900">
        <div className="w-full max-w-md">
          <button 
            onClick={() => setCurrentView('dashboard')}
            className="mb-8 flex items-center gap-2 text-zinc-500 hover:text-zinc-900 transition-colors text-sm font-medium"
          >
            <RotateCcw className="w-4 h-4 rotate-180" />
            Back to Dashboard
          </button>
          
          <div className="bg-white border border-zinc-200 rounded-xl p-8 shadow-sm">
            <div className="mb-8">
              <h1 className="text-2xl font-bold tracking-tight text-zinc-900 mb-2">New Match</h1>
              <p className="text-zinc-500 text-sm">Configure match details to begin scoring.</p>
            </div>
            
            <div className="space-y-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Team 1</label>
                  <input 
                    type="text" 
                    value={teamA} 
                    onChange={e => setTeamA(e.target.value)}
                    className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-lg focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 outline-none transition-all text-sm font-medium text-zinc-900 placeholder-zinc-400"
                    placeholder="Enter Team 1"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Team 2</label>
                  <input 
                    type="text" 
                    value={teamB} 
                    onChange={e => setTeamB(e.target.value)}
                    className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-lg focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 outline-none transition-all text-sm font-medium text-zinc-900 placeholder-zinc-400"
                    placeholder="Enter Team 2"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Overs</label>
                  <input 
                    type="number" 
                    min="1"
                    value={totalOvers} 
                    onChange={e => {
                      const val = e.target.value;
                      if (val === '') {
                        setTotalOvers('');
                      } else {
                        setTotalOvers(Math.max(1, parseInt(val) || 1));
                      }
                    }}
                    className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-lg focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 outline-none transition-all text-sm font-medium text-zinc-900"
                  />
                </div>
              </div>

              <div className="pt-2 space-y-5">
                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Toss Won By</label>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setTossWinner(1)}
                      className={`flex-1 py-3 px-4 rounded-lg text-sm font-semibold transition-all border ${tossWinner === 1 ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'}`}
                    >
                      {teamA || 'Team 1'}
                    </button>
                    <button 
                      onClick={() => setTossWinner(2)}
                      className={`flex-1 py-3 px-4 rounded-lg text-sm font-semibold transition-all border ${tossWinner === 2 ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'}`}
                    >
                      {teamB || 'Team 2'}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Decision</label>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setOptedTo('bat')}
                      className={`flex-1 py-3 px-4 rounded-lg text-sm font-semibold transition-all border ${optedTo === 'bat' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'}`}
                    >
                      Bat
                    </button>
                    <button 
                      onClick={() => setOptedTo('bowl')}
                      className={`flex-1 py-3 px-4 rounded-lg text-sm font-semibold transition-all border ${optedTo === 'bowl' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'}`}
                    >
                      Bowl
                    </button>
                  </div>
                </div>
              </div>

              <button 
                onClick={startMatch}
                className="w-full bg-zinc-900 text-white font-bold py-4 px-4 rounded-lg shadow-sm hover:bg-zinc-800 transition-all flex items-center justify-center gap-2 mt-8 text-sm tracking-wide"
              >
                <Play className="w-4 h-4 fill-current" />
                START MATCH
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (currentView === 'viewer_match') {
    if (!liveMatchData) {
      return (
        <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 font-sans text-zinc-900">
          <div className="w-12 h-12 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin mb-4"></div>
          <p className="text-zinc-500 font-medium">Waiting for live match data...</p>
          <button 
            onClick={() => setCurrentView('viewer_setup')}
            className="mt-8 text-sm font-medium text-zinc-900 hover:underline"
          >
            Go Back
          </button>
        </div>
      );
    }

    const {
      teamA: liveTeamA, teamB: liveTeamB, totalOvers: liveTotalOvers, tossWinner: liveTossWinner, optedTo: liveOptedTo,
      isMatchStarted: liveIsMatchStarted, isMatchOver: liveIsMatchOver, currentInnings: liveCurrentInnings, battingTeam: liveBattingTeam,
      runs: liveRuns, wickets: liveWickets, balls: liveBalls, history: liveHistory, redoStack: liveRedoStack, firstInningsScore: liveFirstInningsScore
    } = liveMatchData;

    const liveBattingTeamName = liveBattingTeam === 1 ? liveTeamA : liveTeamB;
    const liveBowlingTeamName = liveBattingTeam === 1 ? liveTeamB : liveTeamA;

    type TimelineBall = Ball & { isUndone?: boolean };
    const liveOversList: TimelineBall[][] = [[]];
    let legalBallsInCurrentOver = 0;
    
    const fullTimeline: TimelineBall[] = [
      ...liveHistory,
      ...[...(liveRedoStack || [])].reverse().map(b => ({ ...b, isUndone: true }))
    ];

    fullTimeline.forEach(ball => {
      if (legalBallsInCurrentOver === 6) {
        liveOversList.push([]);
        legalBallsInCurrentOver = 0;
      }
      liveOversList[liveOversList.length - 1].push(ball);
      if (ball.isLegal && !ball.isUndone) {
        legalBallsInCurrentOver++;
      }
    });

    return (
      <div className="min-h-screen bg-white flex flex-col font-sans text-zinc-900">
        {/* Header */}
        <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-20 bg-white border-b border-zinc-200">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setCurrentView('viewer_setup')}
              className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
              title="Exit Live View"
            >
              <RotateCcw className="w-4 h-4 rotate-180" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                <span className="text-[10px] font-bold text-red-500 uppercase tracking-widest">Live</span>
              </div>
              <h2 className="text-lg font-bold leading-tight tracking-tight text-zinc-900">{liveBattingTeamName}</h2>
              <p className="text-zinc-500 text-xs font-medium mt-0.5">vs {liveBowlingTeamName}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="bg-zinc-900 px-3 py-1.5 rounded-lg">
              <span className="text-xs text-white font-medium">
                INNINGS {liveCurrentInnings}
              </span>
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 max-w-md w-full mx-auto flex flex-col gap-4 relative z-10">
          {/* Score Card */}
          <div className="bg-white border border-zinc-200 rounded-xl p-8 flex flex-col items-center justify-center relative overflow-hidden">
            <div className="text-zinc-400 text-[10px] font-semibold mb-2 uppercase tracking-widest">Total Score</div>
            <div className="flex items-baseline gap-1">
              <span className="text-6xl leading-none font-bold text-zinc-900 tracking-tighter">{liveRuns}</span>
              <span className="text-4xl font-light text-zinc-300 mx-1">/</span>
              <span className="text-5xl font-semibold text-zinc-500">{liveWickets}</span>
            </div>
            
            <div className="mt-8 flex items-center gap-6 w-full justify-center bg-zinc-50 rounded-lg py-4 border border-zinc-100">
              <div className="flex-1 text-center">
                <div className="text-zinc-400 text-[10px] uppercase tracking-widest font-semibold mb-1">Overs</div>
                <div className="text-2xl font-bold text-zinc-900">{formatOvers(liveBalls)}</div>
              </div>
              <div className="w-px h-10 bg-zinc-200"></div>
              <div className="flex-1 text-center">
                <div className="text-zinc-400 text-[10px] uppercase tracking-widest font-semibold mb-1">Run Rate</div>
                <div className="text-2xl font-bold text-zinc-900">
                  {liveBalls > 0 ? ((liveRuns / liveBalls) * 6).toFixed(2) : '0.00'}
                </div>
              </div>
            </div>

            {/* Innings Progress */}
            <div className="mt-6 w-full">
              <div className="flex justify-between text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-2">
                <span>Innings Progress</span>
                <span>{liveBalls} / {liveTotalOvers * 6} Balls</span>
              </div>
              <div className="flex gap-1 w-full h-1.5">
                {Array.from({ length: liveTotalOvers }).map((_, overIdx) => {
                  const legalBallsInThisOver = Math.max(0, Math.min(6, liveBalls - (overIdx * 6)));
                  const fillPercentage = (legalBallsInThisOver / 6) * 100;
                  
                  return (
                    <div key={overIdx} className="flex-1 bg-zinc-100 rounded-full overflow-hidden relative">
                      <motion.div 
                        className="absolute top-0 left-0 h-full bg-zinc-900"
                        initial={{ width: 0 }}
                        animate={{ width: `${fillPercentage}%` }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {liveCurrentInnings === 2 && liveFirstInningsScore && (
              <div className="mt-6 pt-6 border-t border-zinc-100 w-full text-center">
                <p className="text-sm font-medium text-zinc-500 uppercase tracking-wider">
                  Target <span className="text-zinc-900 font-bold text-xl ml-2">{liveFirstInningsScore.runs + 1}</span>
                </p>
                {!liveIsMatchOver && (
                  <div className="mt-3 inline-block bg-zinc-50 border border-zinc-200 px-4 py-2 rounded-lg">
                    <p className="text-xs font-semibold text-zinc-700 tracking-wide">
                      Need {Math.max(0, liveFirstInningsScore.runs + 1 - liveRuns)} runs from {liveTotalOvers * 6 - liveBalls} balls
                    </p>
                  </div>
                )}
              </div>
            )}
            
            {liveIsMatchOver && (
              <div className="mt-6 pt-6 border-t border-zinc-100 w-full text-center">
                <div className="inline-flex items-center gap-2 bg-zinc-900 text-white px-6 py-4 rounded-xl text-sm font-bold w-full justify-center uppercase tracking-wider">
                  <Trophy className="w-5 h-5" />
                  {liveRuns > (liveFirstInningsScore?.runs || 0) 
                    ? `${liveBattingTeamName} Won by ${10 - liveWickets} wickets!` 
                    : liveRuns === (liveFirstInningsScore?.runs || 0) 
                      ? "Match Tied!" 
                      : `${liveBowlingTeamName} Won by ${liveFirstInningsScore!.runs - liveRuns} runs!`}
                </div>
              </div>
            )}
          </div>

          {/* Innings Timeline */}
          <div className="bg-white border border-zinc-200 rounded-xl p-4">
            <div className="flex justify-between items-center mb-3">
              <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Innings Timeline</div>
              <div className="text-[10px] font-medium text-zinc-400">{liveHistory.length} balls</div>
            </div>
            <div 
              className="flex gap-3 min-h-[40px] items-center overflow-x-auto pb-2 scrollbar-hide snap-x scroll-smooth"
            >
              {liveOversList.map((over, overIdx) => {
                const legalBalls = over.filter(b => b.isLegal).length;
                const showEmptySlots = overIdx === liveOversList.length - 1 && !liveIsMatchOver && liveWickets < 10 && liveBalls < liveTotalOvers * 6;
                const emptySlotsCount = showEmptySlots ? Math.max(0, 6 - legalBalls) : 0;

                return (
                  <div key={overIdx} className="flex gap-2 items-center snap-end">
                    {over.length === 0 && overIdx === 0 && emptySlotsCount > 0 && (
                      <span className="text-zinc-400 text-xs font-medium italic mr-2 whitespace-nowrap">Waiting for first ball...</span>
                    )}
                    
                    {over.map((ball, idx) => (
                      <motion.div 
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: ball.isUndone ? 0.4 : 1 }}
                        key={`ball-${overIdx}-${idx}`} 
                        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold
                          ${ball.isUndone ? 'bg-zinc-100 text-zinc-400 border border-dashed border-zinc-300' :
                            ball.isWicket ? 'bg-red-100 text-red-700 border border-red-200' : 
                            ball.label === '4' || ball.label === '6' ? 'bg-green-100 text-green-700 border border-green-200' : 
                            !ball.isLegal ? 'bg-orange-50 text-orange-700 border border-orange-200' :
                            ball.runs === 0 ? 'bg-zinc-50 text-zinc-400 border border-zinc-200' : 'bg-white text-zinc-900 border border-zinc-200'}
                        `}
                      >
                        {ball.label}
                      </motion.div>
                    ))}
                    
                    {Array.from({ length: emptySlotsCount }).map((_, idx) => (
                      <div key={`empty-${overIdx}-${idx}`} className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border border-dashed border-zinc-200 bg-zinc-50">
                        <div className="w-1 h-1 rounded-full bg-zinc-300"></div>
                      </div>
                    ))}

                    {overIdx < liveOversList.length - 1 && (
                      <div className="w-px h-6 bg-zinc-200 mx-1 flex-shrink-0"></div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {(liveWickets >= 10 || liveBalls >= liveTotalOvers * 6) && liveCurrentInnings === 1 && !liveIsMatchOver && (
            <div className="bg-zinc-900 text-white p-4 rounded-xl text-center text-sm font-bold uppercase tracking-wider">
              Innings Over! Waiting for scorer to start next innings.
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white flex flex-col font-sans text-zinc-900">
      {/* Header */}
      <header className="px-6 py-5 flex justify-between items-center sticky top-0 z-20 bg-white border-b border-zinc-200">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setCurrentView('dashboard')}
            className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
            title="Back to Dashboard"
          >
            <RotateCcw className="w-4 h-4 rotate-180" />
          </button>
          <div>
            <h2 className="text-lg font-bold leading-tight tracking-tight text-zinc-900">{getBattingTeamName()}</h2>
            <p className="text-zinc-500 text-xs font-medium mt-0.5">vs {getBowlingTeamName()}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={handleLogout}
            className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
            title="Logout"
          >
            <LogOut className="w-4 h-4" />
          </button>
          <button 
            onClick={() => setShowHistory(!showHistory)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-700 bg-zinc-100 hover:bg-zinc-200 transition-colors"
          >
            {showHistory ? 'SCORECARD' : 'HISTORY'}
          </button>
          <div className="bg-zinc-900 px-3 py-1.5 rounded-lg">
            <span className="text-xs text-white font-medium">
              INNINGS {currentInnings}
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 p-4 max-w-md w-full mx-auto flex flex-col gap-4 relative z-10">
        {showHistory ? (
          // History View
          <div className="bg-white border border-zinc-200 rounded-xl p-6 flex-1 flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-semibold text-xl tracking-tight">Over History</h3>
              <div className="text-[10px] font-medium text-zinc-500 bg-zinc-100 px-2 py-1 rounded-md">Tap to edit</div>
            </div>
            
            <div className="space-y-4 flex-1">
              {oversWithIndex.map(over => (
                <div key={over.overNumber} className="bg-zinc-50 border border-zinc-200 rounded-xl p-4">
                  <div className="flex justify-between items-center mb-3">
                    <div className="text-xs font-medium text-zinc-500">Over {over.overNumber}</div>
                    <div className="text-xs font-semibold text-zinc-900">
                      {over.balls.reduce((acc, b) => acc + b.runs + b.extras, 0)} runs
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {over.balls.map(ball => (
                      <button
                        key={ball.originalIndex}
                        onClick={() => openEditModal(ball.originalIndex)}
                        className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-transform active:scale-95
                          ${ball.isWicket ? 'bg-red-100 text-red-700 border border-red-200' : 
                            ball.label === '4' || ball.label === '6' ? 'bg-green-100 text-green-700 border border-green-200' : 
                            !ball.isLegal ? 'bg-orange-50 text-orange-700 border border-orange-200' :
                            ball.runs === 0 ? 'bg-zinc-100 text-zinc-400 border border-zinc-200' : 'bg-white text-zinc-900 border border-zinc-200'}
                        `}
                      >
                        {ball.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {history.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-zinc-400 py-12">
                  <div className="w-12 h-12 mb-3 rounded-full bg-zinc-100 flex items-center justify-center">
                    <RotateCcw className="w-5 h-5 text-zinc-300" />
                  </div>
                  <p className="text-sm font-medium">No balls bowled yet</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Score Card */}
            <div className="bg-white border border-zinc-200 rounded-xl p-8 flex flex-col items-center justify-center relative overflow-hidden">
              <div className="text-zinc-400 text-[10px] font-semibold mb-2 uppercase tracking-widest">Total Score</div>
              <div className="flex items-baseline gap-1">
                <span className="text-6xl leading-none font-bold text-zinc-900 tracking-tighter">{runs}</span>
                <span className="text-4xl font-light text-zinc-300 mx-1">/</span>
                <span className="text-5xl font-semibold text-zinc-500">{wickets}</span>
              </div>
              
              <div className="mt-8 flex items-center gap-6 w-full justify-center bg-zinc-50 rounded-lg py-4 border border-zinc-100">
                <div className="flex-1 text-center">
                  <div className="text-zinc-400 text-[10px] uppercase tracking-widest font-semibold mb-1">Overs</div>
                  <div className="text-2xl font-bold text-zinc-900">{formatOvers(balls)}</div>
                </div>
                <div className="w-px h-10 bg-zinc-200"></div>
                <div className="flex-1 text-center">
                  <div className="text-zinc-400 text-[10px] uppercase tracking-widest font-semibold mb-1">Run Rate</div>
                  <div className="text-2xl font-bold text-zinc-900">
                    {balls > 0 ? ((runs / balls) * 6).toFixed(2) : '0.00'}
                  </div>
                </div>
              </div>

              {/* Innings Progress */}
              <div className="mt-6 w-full">
                <div className="flex justify-between text-[10px] font-semibold text-zinc-500 uppercase tracking-widest mb-2">
                  <span>Innings Progress</span>
                  <span>{balls} / {totalOvers * 6} Balls</span>
                </div>
                <div className="flex gap-1 w-full h-1.5">
                  {Array.from({ length: totalOvers }).map((_, overIdx) => {
                    const legalBallsInThisOver = Math.max(0, Math.min(6, balls - (overIdx * 6)));
                    const fillPercentage = (legalBallsInThisOver / 6) * 100;
                    
                    return (
                      <div key={overIdx} className="flex-1 bg-zinc-100 rounded-full overflow-hidden relative">
                        <motion.div 
                          className="absolute top-0 left-0 h-full bg-zinc-900"
                          initial={{ width: 0 }}
                          animate={{ width: `${fillPercentage}%` }}
                          transition={{ duration: 0.5, ease: "easeOut" }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>

              {currentInnings === 2 && firstInningsScore && (
                <div className="mt-6 pt-6 border-t border-zinc-100 w-full text-center">
                  <p className="text-sm font-medium text-zinc-500 uppercase tracking-wider">
                    Target <span className="text-zinc-900 font-bold text-xl ml-2">{firstInningsScore.runs + 1}</span>
                  </p>
                  {!isMatchOver && (
                    <div className="mt-3 inline-block bg-zinc-50 border border-zinc-200 px-4 py-2 rounded-lg">
                      <p className="text-xs font-semibold text-zinc-700 tracking-wide">
                        Need {Math.max(0, firstInningsScore.runs + 1 - runs)} runs from {totalOvers * 6 - balls} balls
                      </p>
                    </div>
                  )}
                </div>
              )}
              
              {isMatchOver && (
                <div className="mt-6 pt-6 border-t border-zinc-100 w-full text-center">
                  <div className="inline-flex items-center gap-2 bg-zinc-900 text-white px-6 py-4 rounded-xl text-sm font-bold w-full justify-center uppercase tracking-wider">
                    <Trophy className="w-5 h-5" />
                    {runs > (firstInningsScore?.runs || 0) 
                      ? `${getBattingTeamName()} Won by ${10 - wickets} wickets!` 
                      : runs === (firstInningsScore?.runs || 0) 
                        ? "Match Tied!" 
                        : `${getBowlingTeamName()} Won by ${firstInningsScore!.runs - runs} runs!`}
                  </div>
                </div>
              )}
            </div>

            {/* Innings Timeline */}
            <div className="bg-white border border-zinc-200 rounded-xl p-4">
              <div className="flex justify-between items-center mb-3">
                <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Innings Timeline</div>
                <div className="text-[10px] font-medium text-zinc-400">{history.length} balls</div>
              </div>
              <div 
                ref={timelineRef}
                className="flex gap-3 min-h-[40px] items-center overflow-x-auto pb-2 scrollbar-hide snap-x scroll-smooth"
              >
                {oversList.map((over, overIdx) => {
                  const legalBalls = over.filter(b => b.isLegal).length;
                  const showEmptySlots = overIdx === oversList.length - 1 && !isMatchOver && wickets < 10 && balls < totalOvers * 6;
                  const emptySlotsCount = showEmptySlots ? Math.max(0, 6 - legalBalls) : 0;

                  return (
                    <div key={overIdx} className="flex gap-2 items-center snap-end">
                      {over.length === 0 && overIdx === 0 && emptySlotsCount > 0 && (
                        <span className="text-zinc-400 text-xs font-medium italic mr-2 whitespace-nowrap">Waiting for first ball...</span>
                      )}
                      
                      {over.map((ball, idx) => (
                        <motion.div 
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: ball.isUndone ? 0.4 : 1 }}
                          key={`ball-${overIdx}-${idx}`} 
                          className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold
                            ${ball.isUndone ? 'bg-zinc-100 text-zinc-400 border border-dashed border-zinc-300' :
                              ball.isWicket ? 'bg-red-100 text-red-700 border border-red-200' : 
                              ball.label === '4' || ball.label === '6' ? 'bg-green-100 text-green-700 border border-green-200' : 
                              !ball.isLegal ? 'bg-orange-50 text-orange-700 border border-orange-200' :
                              ball.runs === 0 ? 'bg-zinc-50 text-zinc-400 border border-zinc-200' : 'bg-white text-zinc-900 border border-zinc-200'}
                          `}
                        >
                          {ball.label}
                        </motion.div>
                      ))}
                      
                      {Array.from({ length: emptySlotsCount }).map((_, idx) => (
                        <div key={`empty-${overIdx}-${idx}`} className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border border-dashed border-zinc-200 bg-zinc-50">
                          <div className="w-1 h-1 rounded-full bg-zinc-300"></div>
                        </div>
                      ))}

                      {overIdx < oversList.length - 1 && (
                        <div className="w-px h-6 bg-zinc-200 mx-1 flex-shrink-0"></div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {(wickets >= 10 || balls >= totalOvers * 6) && currentInnings === 1 && !isMatchOver && (
              <div className="bg-zinc-900 text-white p-4 rounded-xl text-center text-sm font-bold uppercase tracking-wider">
                Innings Over! Declare to continue.
              </div>
            )}

            {/* Controls */}
            <div className="bg-white border border-zinc-200 rounded-xl p-6 mt-auto">
              {!isMatchOver && wickets < 10 && balls < totalOvers * 6 && (
                <>
                  {isNbMode && (
                    <div className="text-center mb-4 text-[10px] font-bold text-orange-600 uppercase tracking-widest animate-pulse bg-orange-50 py-2.5 rounded-lg border border-orange-200">
                      Select runs scored off No Ball
                    </div>
                  )}
                  <div className="grid grid-cols-4 gap-3 mb-3">
                    {[0, 1, 2, 3].map(r => (
                      <button
                        key={r}
                        onClick={() => handleRunClick(r)}
                        className="py-4 rounded-xl font-bold text-xl bg-white text-zinc-900 hover:bg-zinc-100 border border-zinc-200 transition-colors active:bg-zinc-200"
                      >
                        {r}
                      </button>
                    ))}
                    <button
                      onClick={() => handleRunClick(4)}
                      className="py-4 rounded-xl font-bold text-xl bg-white text-green-600 hover:bg-green-50 border border-green-200 transition-colors active:bg-green-100"
                    >
                      4
                    </button>
                    <button
                      onClick={() => handleRunClick(6)}
                      className="py-4 rounded-xl font-bold text-xl bg-green-600 text-white hover:bg-green-700 transition-colors active:bg-green-800"
                    >
                      6
                    </button>
                    <button
                      onClick={() => {
                        addBall(0, false, false, 'Wd', 1);
                        setIsNbMode(false);
                      }}
                      className="py-4 rounded-xl font-bold text-lg bg-white text-zinc-900 hover:bg-zinc-100 border border-zinc-200 transition-colors active:bg-zinc-200"
                    >
                      Wd
                    </button>
                    <button
                      onClick={() => setIsNbMode(m => !m)}
                      className={`py-4 rounded-xl font-bold text-lg border transition-colors ${
                        isNbMode 
                          ? 'bg-orange-600 text-white border-orange-600 active:bg-orange-700' 
                          : 'bg-white text-orange-600 hover:bg-orange-50 border-orange-200 active:bg-orange-100'
                      }`}
                    >
                      NB
                    </button>
                  </div>
                </>
              )}
              
              <div className="grid grid-cols-4 gap-3 mt-3">
                {!isMatchOver && wickets < 10 && balls < totalOvers * 6 && (
                  <button
                    onClick={handleWicketClick}
                    className="col-span-2 py-3 rounded-xl font-bold text-sm bg-red-600 text-white hover:bg-red-700 transition-colors active:bg-red-800 tracking-widest"
                  >
                    WICKET
                  </button>
                )}
                <button
                  onClick={undo}
                  disabled={history.length === 0}
                  className={`py-3 rounded-xl font-bold text-xs bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed flex flex-col items-center justify-center gap-1 transition-colors active:bg-zinc-950 tracking-widest ${isMatchOver || wickets >= 10 || balls >= totalOvers * 6 ? 'col-span-2 flex-row' : 'col-span-1'}`}
                >
                  <RotateCcw className="w-4 h-4" />
                  UNDO
                </button>
                <button
                  onClick={redo}
                  disabled={redoStack.length === 0}
                  className={`py-3 rounded-xl font-bold text-xs bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed flex flex-col items-center justify-center gap-1 transition-colors active:bg-zinc-950 tracking-widest ${isMatchOver || wickets >= 10 || balls >= totalOvers * 6 ? 'col-span-2 flex-row' : 'col-span-1'}`}
                >
                  <RotateCw className="w-4 h-4" />
                  REDO
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 pb-6">
              {!isMatchOver && currentInnings === 1 && (
                <button
                  onClick={endInnings}
                  className="flex-1 bg-white border border-zinc-200 text-zinc-900 font-bold py-3 px-4 rounded-xl hover:bg-zinc-100 transition-colors active:bg-zinc-200 flex items-center justify-center gap-2 tracking-widest text-sm"
                >
                  DECLARE INNINGS
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
              
              {isMatchOver && (
                <button
                  onClick={resetMatch}
                  className="flex-1 bg-zinc-900 text-white font-bold py-3 px-4 rounded-xl hover:bg-zinc-800 transition-colors active:bg-zinc-950 flex items-center justify-center gap-2 tracking-widest text-sm"
                >
                  <RotateCcw className="w-4 h-4" />
                  NEW MATCH
                </button>
              )}
            </div>
          </>
        )}
      </main>

      {/* Edit Ball Modal */}
      {editingBallIndex !== null && (
        <div className="fixed inset-0 bg-zinc-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white border border-zinc-200 rounded-2xl p-6 w-full max-w-sm shadow-xl">
            <h3 className="font-bold text-xl text-zinc-900 mb-1 tracking-tight">Edit Delivery</h3>
            <p className="text-sm font-medium text-zinc-500 mb-6">Update the details for this ball.</p>
            
            <div className="space-y-6 mb-8">
              {/* Runs */}
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Runs Scored</label>
                <div className="grid grid-cols-6 gap-2">
                  {[0, 1, 2, 3, 4, 6].map(r => (
                    <button
                      key={r}
                      onClick={() => setEditRuns(r)}
                      className={`py-2 rounded-lg font-bold text-sm border transition-all ${editRuns === r ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              {/* Extras */}
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Delivery Type</label>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setEditExtraType('none')}
                    className={`flex-1 py-2 rounded-lg font-bold text-sm border transition-all ${editExtraType === 'none' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'}`}
                  >
                    Legal
                  </button>
                  <button 
                    onClick={() => setEditExtraType('wd')}
                    className={`flex-1 py-2 rounded-lg font-bold text-sm border transition-all ${editExtraType === 'wd' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'}`}
                  >
                    Wide
                  </button>
                  <button 
                    onClick={() => setEditExtraType('nb')}
                    className={`flex-1 py-2 rounded-lg font-bold text-sm border transition-all ${editExtraType === 'nb' ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'}`}
                  >
                    No Ball
                  </button>
                </div>
              </div>

              {/* Wicket */}
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Wicket</label>
                <button
                  onClick={() => setEditIsWicket(!editIsWicket)}
                  className={`w-full py-2 rounded-lg font-bold text-sm border transition-all ${editIsWicket ? 'bg-red-600 text-white border-red-600' : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50'}`}
                >
                  {editIsWicket ? 'WICKET FALLEN' : 'NO WICKET'}
                </button>
              </div>
            </div>
            
            <div className="flex gap-3">
              <button 
                onClick={() => setEditingBallIndex(null)}
                className="flex-1 py-3 rounded-lg font-bold text-sm bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50 transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={saveEditedBall}
                className="flex-1 py-3 rounded-lg font-bold text-sm bg-zinc-900 text-white hover:bg-zinc-800 transition-all"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
