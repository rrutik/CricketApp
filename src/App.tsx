import React, { useState, useEffect } from 'react';
import { RotateCcw, RotateCw, Trophy, Play, ChevronRight, User, LogIn, LogOut, Sparkles, ShieldCheck, Zap } from 'lucide-react';
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
  isPowerOver?: boolean;
  actualRunsAdded?: number;
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
  const [matchCode, setMatchCode] = useState<string | null>(null);
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
  const [hasPowerOver, setHasPowerOver] = useState(false);
  const [powerOverPenalty, setPowerOverPenalty] = useState(5);
  const [powerOvers, setPowerOvers] = useState<{1: number | null, 2: number | null}>({1: null, 2: null});
  
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
            setCurrentView('dashboard');
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
      if (state.matchCode) setMatchCode(state.matchCode);
      if (state.hasPowerOver !== undefined) setHasPowerOver(state.hasPowerOver);
      if (state.powerOverPenalty !== undefined) setPowerOverPenalty(state.powerOverPenalty);
      if (state.powerOvers !== undefined) setPowerOvers(state.powerOvers);
      setFirstInningsScore(state.firstInningsScore);
      if (state.isMatchStarted && !state.isMatchOver) {
        // Do not auto-redirect to match, let user use dashboard to resume
      }
    }
  }, []);

  useEffect(() => {
    if (isMatchStarted) {
      const state = {
        teamA, teamB, totalOvers, tossWinner, optedTo,
        isMatchStarted, isMatchOver, currentInnings, battingTeam,
        runs, wickets, balls, history, redoStack, firstInningsScore,
        matchCode, hasPowerOver, powerOverPenalty, powerOvers
      };
      localStorage.setItem('cricscore_current_match', JSON.stringify(state));
      
      if (role === 'scorer' && matchCode) {
        setDoc(doc(db, 'live_matches', matchCode), state).catch(err => {
          handleFirestoreError(err, OperationType.WRITE, `live_matches/${matchCode}`);
        });
      }
    } else {
      localStorage.removeItem('cricscore_current_match');
    }
  }, [isMatchStarted, isMatchOver, runs, wickets, balls, history, redoStack, currentInnings, battingTeam, teamA, teamB, totalOvers, tossWinner, optedTo, firstInningsScore, role, matchCode, hasPowerOver, powerOverPenalty, powerOvers]);

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
    setPowerOvers({1: null, 2: null});

    if (optedTo === 'bat') {
      setBattingTeam(tossWinner);
    } else {
      setBattingTeam(tossWinner === 1 ? 2 : 1);
    }
    
    if (!matchCode) {
      setMatchCode(Math.floor(1000 + Math.random() * 9000).toString());
    }
    
    setIsMatchStarted(true);
    setCurrentView('match');
  };

  const addBall = (runsScored: number, isWicket: boolean, isLegal: boolean, label: string, extraRuns: number = 0, isRedo: boolean = false, isPowerOverArg?: boolean, actualRunsAddedArg?: number) => {
    if (wickets >= 10 || balls >= totalOvers * 6 || isMatchOver) return;
    
    if (!isRedo) {
      setRedoStack([]);
    }
    
    const currentOverIndex = Math.floor(balls / 6);
    const isPowerOverActive = isRedo ? !!isPowerOverArg : (hasPowerOver && powerOvers[currentInnings] === currentOverIndex);
    
    let totalRunsAdded = runsScored + extraRuns;
    let finalLabel = label;
    
    if (!isRedo && isPowerOverActive) {
      totalRunsAdded *= 2;
      if (isWicket) {
        totalRunsAdded -= powerOverPenalty;
        finalLabel = `${label}(-${powerOverPenalty})`;
      } else if (runsScored > 0) {
        finalLabel = `${label}x2`;
      } else if (extraRuns > 0) {
        finalLabel = `${label}x2`;
      }
    } else if (isRedo && actualRunsAddedArg !== undefined) {
      totalRunsAdded = actualRunsAddedArg;
    }
    
    const newRuns = runs + totalRunsAdded;
    const newWickets = wickets + (isWicket ? 1 : 0);
    const newBalls = balls + (isLegal ? 1 : 0);
    
    setRuns(newRuns);
    if (isWicket) setWickets(newWickets);
    if (isLegal) setBalls(newBalls);
    
    setHistory(h => [...h, { runs: runsScored, extras: extraRuns, isWicket, isLegal, label: finalLabel, isPowerOver: isPowerOverActive, actualRunsAdded: totalRunsAdded }]);
    
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
    const runsToSubtract = last.actualRunsAdded !== undefined ? last.actualRunsAdded : (last.runs + last.extras);
    setRuns(r => r - runsToSubtract);
    if (last.isWicket) setWickets(w => w - 1);
    if (last.isLegal) setBalls(b => b - 1);
    setHistory(h => h.slice(0, -1));
    setIsNbMode(false);
    
    if (currentInnings === 2 && firstInningsScore) {
      const newRuns = runs - runsToSubtract;
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
    addBall(next.runs, next.isWicket, next.isLegal, next.label, next.extras, true, next.isPowerOver, next.actualRunsAdded);
  };

  const recalculateScore = (newHistory: Ball[]) => {
    let newRuns = 0;
    let newWickets = 0;
    let newBalls = 0;
    
    newHistory.forEach(ball => {
      newRuns += ball.actualRunsAdded !== undefined ? ball.actualRunsAdded : (ball.runs + ball.extras);
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

  const togglePowerOver = () => {
    const currentOverIndex = Math.floor(balls / 6);
    const isActivating = powerOvers[currentInnings] == null;
    
    if (!isActivating && powerOvers[currentInnings] !== currentOverIndex) {
      return; // Cannot deactivate if it's not the current over
    }
    
    setPowerOvers(prev => ({ ...prev, [currentInnings]: isActivating ? currentOverIndex : null }));
    
    let legalBallsCount = 0;
    
    const newHistory = history.map(ball => {
      const overIndex = Math.floor(legalBallsCount / 6);
      
      let newBall = { ...ball };
      
      if (overIndex === currentOverIndex) {
        // Recalculate this ball
        let totalRunsAdded = ball.runs + ball.extras;
        let finalLabel = ball.label.replace('x2', '').replace(`(-${powerOverPenalty})`, '');
        
        if (isActivating) {
          totalRunsAdded *= 2;
          if (ball.isWicket) {
            totalRunsAdded -= powerOverPenalty;
            finalLabel = `${finalLabel}(-${powerOverPenalty})`;
          } else if (ball.runs > 0 || ball.extras > 0) {
            finalLabel = `${finalLabel}x2`;
          }
        }
        
        newBall = {
          ...ball,
          label: finalLabel,
          isPowerOver: isActivating,
          actualRunsAdded: totalRunsAdded
        };
      }
      
      if (ball.isLegal) {
        legalBallsCount++;
      }
      return newBall;
    });
    
    recalculateScore(newHistory);
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
    
    let totalRunsAdded = ball.runs + ball.extras;
    if (ball.isPowerOver) {
      totalRunsAdded *= 2;
      if (ball.isWicket) {
        totalRunsAdded -= powerOverPenalty;
        ball.label = `${ball.label}(-${powerOverPenalty})`;
      } else if (ball.runs > 0 || ball.extras > 0) {
        ball.label = `${ball.label}x2`;
      }
    }
    ball.actualRunsAdded = totalRunsAdded;
    
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
    setPowerOvers({1: null, 2: null});
    setMatchCode(Math.floor(1000 + Math.random() * 9000).toString());
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
          setCurrentView('dashboard');
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
      <div className="min-h-screen bg-bg-card flex flex-col items-center justify-center p-6 font-sans text-text-primary">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="w-full max-w-sm flex flex-col items-center"
        >
          <div className="w-16 h-16 mb-6 bg-bg-muted rounded-2xl flex items-center justify-center border border-border-default shadow-sm">
            <Trophy className="w-8 h-8 text-text-primary" />
          </div>
          
          <h1 className="text-3xl font-bold tracking-tight mb-2 text-center">
            CricScore
          </h1>
          <p className="text-text-secondary text-sm text-center mb-10">
            The minimal scoring companion.
          </p>

          <div className="w-full space-y-3">
            <button 
              onClick={() => handleLogin('guest')}
              className="w-full bg-primary-navy text-text-white font-medium py-3 px-4 rounded-lg flex items-center justify-center gap-2 hover:bg-primary-blue transition-colors active:scale-[0.98]"
            >
              <User className="w-4 h-4" />
              Continue as Guest
            </button>

            <button 
              onClick={() => handleLogin('user')}
              className="w-full bg-bg-card text-text-primary font-medium py-3 px-4 rounded-lg flex items-center justify-center gap-2 border border-border-default hover:bg-bg-muted transition-colors active:scale-[0.98]"
            >
              <LogIn className="w-4 h-4" />
              Login with Google
            </button>
          </div>

          <div className="mt-12 flex items-center justify-center gap-2 text-text-light">
            <ShieldCheck className="w-4 h-4" />
            <span className="text-xs font-medium">Secure & Private</span>
          </div>
        </motion.div>
      </div>
    );
  }

  if (currentView === 'role_select') {
    return (
      <div className="min-h-screen bg-bg-card flex flex-col items-center justify-center p-6 font-sans text-text-primary">
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="w-full max-w-sm flex flex-col items-center"
        >
          <div className="w-16 h-16 bg-primary-navy rounded-2xl flex items-center justify-center mb-8 shadow-xl shadow-border-default\/50">
            <Trophy className="w-8 h-8 text-text-white" />
          </div>
          
          <h1 className="text-3xl font-bold tracking-tight mb-2 text-center">Choose Your Role</h1>
          <p className="text-text-secondary text-center mb-10 text-sm">Are you scoring a match or viewing one?</p>
          
          <div className="w-full space-y-4">
            <button 
              onClick={() => {
                setRole('scorer');
                if (!matchCode) {
                  setMatchCode(Math.floor(1000 + Math.random() * 9000).toString());
                }
                setCurrentView('dashboard');
              }}
              className="w-full bg-primary-navy hover:bg-primary-blue text-text-white font-medium py-4 px-6 rounded-xl transition-all flex items-center justify-center gap-3 shadow-sm"
            >
              <ShieldCheck className="w-5 h-5" />
              I want to Score a Match
            </button>
            
            <button 
              onClick={() => {
                setRole('viewer');
                setCurrentView('viewer_setup');
              }}
              className="w-full bg-bg-card hover:bg-bg-muted text-text-primary border border-border-default font-medium py-4 px-6 rounded-xl transition-all flex items-center justify-center gap-3 shadow-sm"
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
      <div className="min-h-screen bg-bg-card flex flex-col font-sans text-text-primary">
        <header className="px-6 py-8 flex justify-between items-center max-w-md mx-auto w-full">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
            <p className="text-text-secondary text-sm">Welcome back, {userType === 'guest' ? 'Guest' : 'User'}</p>
          </div>
          <button 
            onClick={handleLogout}
            className="w-10 h-10 bg-bg-card rounded-lg border border-border-default flex items-center justify-center text-text-secondary hover:bg-bg-muted hover:text-text-primary transition-colors active:scale-95"
            title="Log out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </header>

        <main className="flex-1 px-6 pb-6 space-y-6 max-w-md mx-auto w-full">
          {/* Scorer ID Banner */}
          {role === 'scorer' && (
            <div className="bg-bg-muted border border-border-default rounded-2xl p-5 flex flex-col items-center text-center">
              <h3 className="text-sm font-bold text-text-primary mb-1">Your Scorer ID</h3>
              {matchCode ? (
                <>
                  <p className="text-xs text-text-secondary mb-3">Share this ID with viewers to let them watch your match live.</p>
                  <div className="bg-bg-card border border-border-default px-4 py-2 rounded-lg text-lg font-mono font-bold tracking-widest text-text-primary select-all">
                    {matchCode}
                  </div>
                </>
              ) : (
                <p className="text-xs text-text-secondary">
                  Generating Scorer ID...
                </p>
              )}
            </div>
          )}

          {/* Create Match Banner */}
          <motion.div 
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.99 }}
            onClick={() => setCurrentView('setup')}
            className="bg-primary-navy rounded-xl p-6 text-text-white shadow-sm cursor-pointer group relative overflow-hidden"
          >
            <div className="relative z-10">
              <div className="w-10 h-10 bg-primary-blue rounded-lg flex items-center justify-center mb-4 border border-primary-blue">
                <Play className="w-5 h-5 fill-current" />
              </div>
              <h2 className="text-xl font-bold mb-1">Create New Match</h2>
              <p className="text-text-light text-sm">Set up teams, overs and toss to begin scoring.</p>
            </div>
            <div className="absolute bottom-6 right-6">
              <ChevronRight className="w-6 h-6 text-text-secondary group-hover:text-text-light transition-colors" />
            </div>
          </motion.div>

          {/* View Match Banner */}
          <div className="bg-bg-card border border-border-default rounded-xl p-5 shadow-sm">
            <h3 className="font-semibold text-text-primary mb-3 flex items-center gap-2">
              <User className="w-4 h-4 text-text-secondary" />
              View Live Match
            </h3>
            <div className="flex gap-2">
              <input 
                type="text" 
                value={viewerScorerId}
                onChange={(e) => setViewerScorerId(e.target.value)}
                placeholder="Enter Scorer ID"
                className="flex-1 p-3 bg-bg-muted border border-border-default rounded-lg focus:ring-2 focus:ring-primary-navy focus:border-transparent outline-none transition-all font-medium text-sm"
              />
              <button 
                onClick={() => {
                  if (viewerScorerId.trim()) {
                    setRole('viewer');
                    setCurrentView('viewer_match');
                  }
                }}
                disabled={!viewerScorerId.trim()}
                className="bg-primary-navy hover:bg-primary-blue disabled:bg-border-default disabled:text-text-light text-text-white font-medium px-5 rounded-lg transition-all flex items-center justify-center shadow-sm"
              >
                Watch
              </button>
            </div>
          </div>

          {/* Resume Match (Conditional) */}
          {isMatchStarted && !isMatchOver && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={() => setCurrentView('match')}
              className="bg-bg-card border border-border-default rounded-xl p-5 shadow-sm hover:border-border-default hover:bg-bg-muted transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-bg-muted rounded-lg flex items-center justify-center text-text-primary border border-border-default">
                    <RotateCcw className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-text-primary">Resume Match</h3>
                    <p className="text-xs text-text-secondary font-medium">{teamA} vs {teamB}</p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-text-primary">{runs}/{wickets}</div>
                  <div className="text-xs text-text-secondary font-medium">{formatOvers(balls)} Overs</div>
                </div>
              </div>
            </motion.div>
          )}

          {/* Recent History */}
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-semibold text-lg tracking-tight">Recent Matches</h3>
              <span className="text-xs font-medium text-text-light">Last 3</span>
            </div>
            
            <div className="space-y-3">
              {matchHistory.slice(0, 3).map(match => (
                <div key={match.id} className="bg-bg-card border border-border-default rounded-xl p-4 shadow-sm hover:border-border-default transition-colors">
                  <div className="flex justify-between items-center mb-3">
                    <div className="text-xs font-medium text-text-secondary">{match.date}</div>
                    <div className="text-[10px] font-medium text-text-secondary bg-bg-muted px-2 py-0.5 rounded-md">Finished</div>
                  </div>
                  <div className="flex justify-between items-center">
                    <div className="flex-1">
                      <div className="font-semibold text-text-primary">{match.teamA}</div>
                      <div className="text-xs text-text-secondary">{match.innings1.runs}/{match.innings1.wickets} <span className="text-text-light">({formatOvers(match.innings1.balls)})</span></div>
                    </div>
                    <div className="px-4 text-xs font-medium text-text-light">VS</div>
                    <div className="flex-1 text-right">
                      <div className="font-semibold text-text-primary">{match.teamB}</div>
                      <div className="text-xs text-text-secondary">{match.innings2?.runs}/{match.innings2?.wickets} <span className="text-text-light">({formatOvers(match.innings2?.balls || 0)})</span></div>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-border-light text-center">
                    <p className="text-xs font-medium text-text-secondary">{match.resultMessage}</p>
                  </div>
                </div>
              ))}
              {matchHistory.length === 0 && (
                <div className="text-center py-10 bg-bg-muted border border-dashed border-border-default rounded-xl">
                  <Trophy className="w-8 h-8 text-text-light mx-auto mb-3" />
                  <p className="text-sm font-medium text-text-secondary">No matches played yet</p>
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
      <div className="min-h-screen bg-bg-card flex flex-col items-center justify-center p-6 font-sans text-text-primary">
        <div className="w-full max-w-md">
          <button 
            onClick={() => setCurrentView('role_select')}
            className="mb-8 flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium"
          >
            <ChevronRight className="w-4 h-4 rotate-180" />
            Back to Roles
          </button>
          
          <h2 className="text-3xl font-bold tracking-tight mb-2">View Live Match</h2>
          <p className="text-text-secondary mb-8 text-sm">Enter the Scorer ID to view their live match.</p>
          
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-text-secondary">Scorer ID</label>
              <input 
                type="text" 
                value={viewerScorerId}
                onChange={(e) => setViewerScorerId(e.target.value)}
                placeholder="e.g. 1234"
                className="w-full p-4 bg-bg-muted border border-border-default rounded-xl focus:ring-2 focus:ring-primary-navy focus:border-transparent outline-none transition-all font-medium text-lg"
              />
            </div>
            
            <button 
              onClick={() => {
                if (viewerScorerId.trim()) {
                  setCurrentView('viewer_match');
                }
              }}
              disabled={!viewerScorerId.trim()}
              className="w-full bg-primary-navy hover:bg-primary-blue disabled:bg-border-default disabled:text-text-light text-text-white font-medium py-4 px-6 rounded-xl transition-all flex items-center justify-center gap-2 shadow-sm"
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
      <div className="min-h-screen bg-bg-card flex flex-col items-center justify-center p-6 font-sans text-text-primary">
        <div className="w-full max-w-md">
          <button 
            onClick={() => setCurrentView('dashboard')}
            className="mb-8 flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium"
          >
            <RotateCcw className="w-4 h-4 rotate-180" />
            Back to Dashboard
          </button>
          
          <div className="bg-bg-card border border-border-default rounded-xl p-8 shadow-sm">
            <div className="mb-8">
              <h1 className="text-2xl font-bold tracking-tight text-text-primary mb-2">New Match</h1>
              <p className="text-text-secondary text-sm">Configure match details to begin scoring.</p>
            </div>
            
            <div className="space-y-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">Team 1</label>
                  <input 
                    type="text" 
                    value={teamA} 
                    onChange={e => setTeamA(e.target.value)}
                    className="w-full px-4 py-3 bg-bg-muted border border-border-default rounded-lg focus:ring-2 focus:ring-primary-navy focus:border-primary-navy outline-none transition-all text-sm font-medium text-text-primary placeholder-text-light"
                    placeholder="Enter Team 1"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">Team 2</label>
                  <input 
                    type="text" 
                    value={teamB} 
                    onChange={e => setTeamB(e.target.value)}
                    className="w-full px-4 py-3 bg-bg-muted border border-border-default rounded-lg focus:ring-2 focus:ring-primary-navy focus:border-primary-navy outline-none transition-all text-sm font-medium text-text-primary placeholder-text-light"
                    placeholder="Enter Team 2"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">Overs</label>
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
                    className="w-full px-4 py-3 bg-bg-muted border border-border-default rounded-lg focus:ring-2 focus:ring-primary-navy focus:border-primary-navy outline-none transition-all text-sm font-medium text-text-primary"
                  />
                </div>
              </div>

              <div className="pt-2 space-y-5">
                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">Toss Won By</label>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setTossWinner(1)}
                      className={`flex-1 py-3 px-4 rounded-lg text-sm font-semibold transition-all border ${tossWinner === 1 ? 'bg-primary-navy text-text-white border-primary-navy' : 'bg-bg-card text-text-secondary border-border-default hover:bg-bg-muted'}`}
                    >
                      {teamA || 'Team 1'}
                    </button>
                    <button 
                      onClick={() => setTossWinner(2)}
                      className={`flex-1 py-3 px-4 rounded-lg text-sm font-semibold transition-all border ${tossWinner === 2 ? 'bg-primary-navy text-text-white border-primary-navy' : 'bg-bg-card text-text-secondary border-border-default hover:bg-bg-muted'}`}
                    >
                      {teamB || 'Team 2'}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">Decision</label>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setOptedTo('bat')}
                      className={`flex-1 py-3 px-4 rounded-lg text-sm font-semibold transition-all border ${optedTo === 'bat' ? 'bg-primary-navy text-text-white border-primary-navy' : 'bg-bg-card text-text-secondary border-border-default hover:bg-bg-muted'}`}
                    >
                      Bat
                    </button>
                    <button 
                      onClick={() => setOptedTo('bowl')}
                      className={`flex-1 py-3 px-4 rounded-lg text-sm font-semibold transition-all border ${optedTo === 'bowl' ? 'bg-primary-navy text-text-white border-primary-navy' : 'bg-bg-card text-text-secondary border-border-default hover:bg-bg-muted'}`}
                    >
                      Bowl
                    </button>
                  </div>
                </div>
                
                <div className="pt-2">
                  <div className="flex items-center justify-between p-4 bg-bg-muted border border-border-default rounded-xl">
                    <div>
                      <h3 className="font-bold text-text-primary text-sm">Power Over</h3>
                      <p className="text-[10px] text-text-secondary mt-0.5">Double runs, minus runs on wicket</p>
                    </div>
                    <button
                      onClick={() => setHasPowerOver(!hasPowerOver)}
                      className={`w-12 h-6 rounded-full transition-colors relative ${hasPowerOver ? 'bg-status-live' : 'bg-border-default'}`}
                    >
                      <div className={`w-4 h-4 rounded-full bg-bg-card absolute top-1 transition-transform ${hasPowerOver ? 'left-7' : 'left-1'}`} />
                    </button>
                  </div>
                  
                  {hasPowerOver && (
                    <div className="mt-4">
                      <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">Wicket Penalty (Minus Runs)</label>
                      <input 
                        type="number" 
                        value={powerOverPenalty}
                        onChange={(e) => setPowerOverPenalty(parseInt(e.target.value) || 0)}
                        className="w-full p-3 bg-bg-muted border border-border-default rounded-lg focus:ring-2 focus:ring-primary-navy focus:border-transparent outline-none transition-all font-medium"
                      />
                    </div>
                  )}
                </div>
              </div>

              <button 
                onClick={startMatch}
                className="w-full bg-primary-navy text-text-white font-bold py-4 px-4 rounded-lg shadow-sm hover:bg-primary-blue transition-all flex items-center justify-center gap-2 mt-8 text-sm tracking-wide"
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
        <div className="min-h-screen bg-bg-card flex flex-col items-center justify-center p-6 font-sans text-text-primary">
          <div className="w-12 h-12 border-4 border-border-default border-t-primary-navy rounded-full animate-spin mb-4"></div>
          <p className="text-text-secondary font-medium">Waiting for live match data...</p>
          <button 
            onClick={() => setCurrentView('viewer_setup')}
            className="mt-8 text-sm font-medium text-text-primary hover:underline"
          >
            Go Back
          </button>
        </div>
      );
    }

    const {
      teamA: liveTeamA, teamB: liveTeamB, totalOvers: liveTotalOvers, tossWinner: liveTossWinner, optedTo: liveOptedTo,
      isMatchStarted: liveIsMatchStarted, isMatchOver: liveIsMatchOver, currentInnings: liveCurrentInnings, battingTeam: liveBattingTeam,
      runs: liveRuns, wickets: liveWickets, balls: liveBalls, history: liveHistory, redoStack: liveRedoStack, firstInningsScore: liveFirstInningsScore,
      hasPowerOver: liveHasPowerOver, powerOvers: livePowerOvers
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
      <div className="min-h-screen bg-bg-card flex flex-col font-sans text-text-primary">
        {/* Header */}
        <header className="px-4 py-3 flex justify-between items-center sticky top-0 z-20 bg-bg-card border-b border-border-default">
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setCurrentView('viewer_setup')}
              className="p-2 rounded-lg text-text-secondary hover:bg-bg-muted hover:text-text-primary transition-colors"
              title="Exit Live View"
            >
              <RotateCcw className="w-4 h-4 rotate-180" />
            </button>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-status-wicket animate-pulse"></span>
              <h2 className="text-lg font-bold leading-tight tracking-tight text-text-primary">{liveBattingTeamName}</h2>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="bg-primary-navy px-3 py-1.5 rounded-lg">
              <span className="text-xs text-text-white font-bold tracking-wide">
                INNINGS {liveCurrentInnings}
              </span>
            </div>
          </div>
        </header>

        <main className="flex-1 p-4 max-w-md w-full mx-auto flex flex-col gap-4 relative z-10">
          {/* Score Card */}
          <div className={`bg-bg-card border rounded-xl p-8 flex flex-col items-center justify-center relative overflow-hidden transition-colors ${liveHasPowerOver && livePowerOvers?.[liveCurrentInnings] === Math.floor(liveBalls / 6) ? 'border-primary-bright\/50 ring-2 ring-btn-wide-bg' : 'border-border-default'}`}>
            {liveHasPowerOver && livePowerOvers?.[liveCurrentInnings] === Math.floor(liveBalls / 6) && (
              <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-primary-bright via-primary-blue to-primary-bright animate-pulse" />
            )}
            <div className="flex items-center gap-2 mb-2">
              <div className="text-text-light text-[10px] font-semibold uppercase tracking-widest">Total Score</div>
              {liveHasPowerOver && livePowerOvers?.[liveCurrentInnings] === Math.floor(liveBalls / 6) && (
                <div className="flex items-center gap-1 text-[10px] font-bold text-primary-bright bg-btn-wide-bg px-2 py-0.5 rounded uppercase tracking-widest">
                  <Zap className="w-3 h-3 fill-current" />
                  Power Over
                </div>
              )}
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-6xl leading-none font-bold text-text-primary tracking-tighter">{liveRuns}</span>
              <span className="text-4xl font-light text-text-light mx-1">/</span>
              <span className="text-5xl font-semibold text-text-secondary">{liveWickets}</span>
            </div>
            
            <div className="mt-8 flex items-center gap-6 w-full justify-center bg-bg-muted rounded-lg py-4 border border-border-light">
              <div className="flex-1 text-center">
                <div className="text-text-light text-[10px] uppercase tracking-widest font-semibold mb-1">Overs</div>
                <div className="text-2xl font-bold text-text-primary">{formatOvers(liveBalls)}</div>
              </div>
              <div className="w-px h-10 bg-border-default"></div>
              <div className="flex-1 text-center">
                <div className="text-text-light text-[10px] uppercase tracking-widest font-semibold mb-1">Run Rate</div>
                <div className="text-2xl font-bold text-text-primary">
                  {liveBalls > 0 ? ((liveRuns / liveBalls) * 6).toFixed(2) : '0.00'}
                </div>
              </div>
            </div>

            {/* Innings Progress */}
            <div className="mt-6 w-full">
              <div className="flex justify-between text-[10px] font-semibold text-text-secondary uppercase tracking-widest mb-2">
                <span>Innings Progress</span>
                <span>{liveBalls} / {liveTotalOvers * 6} Balls</span>
              </div>
              <div className="flex gap-1 w-full h-1.5">
                {Array.from({ length: liveTotalOvers }).map((_, overIdx) => {
                  const legalBallsInThisOver = Math.max(0, Math.min(6, liveBalls - (overIdx * 6)));
                  const fillPercentage = (legalBallsInThisOver / 6) * 100;
                  
                  return (
                    <div key={overIdx} className="flex-1 bg-bg-muted rounded-full overflow-hidden relative">
                      <motion.div 
                        className="absolute top-0 left-0 h-full bg-primary-navy"
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
              <div className="mt-6 pt-6 border-t border-border-light w-full text-center">
                <p className="text-sm font-medium text-text-secondary uppercase tracking-wider">
                  Target <span className="text-text-primary font-bold text-xl ml-2">{liveFirstInningsScore.runs + 1}</span>
                </p>
                {!liveIsMatchOver && (
                  <div className="mt-3 inline-block bg-bg-muted border border-border-default px-4 py-2 rounded-lg">
                    <p className="text-xs font-semibold text-text-primary tracking-wide">
                      Need {Math.max(0, liveFirstInningsScore.runs + 1 - liveRuns)} runs from {liveTotalOvers * 6 - liveBalls} balls
                    </p>
                  </div>
                )}
              </div>
            )}
            
            {liveIsMatchOver && (
              <div className="mt-6 pt-6 border-t border-border-light w-full text-center">
                <div className="inline-flex items-center gap-2 bg-primary-navy text-text-white px-6 py-4 rounded-xl text-sm font-bold w-full justify-center uppercase tracking-wider">
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
          <div className="bg-bg-card border border-border-default rounded-xl p-4">
            <div className="flex justify-between items-center mb-3">
              <div className="text-[10px] font-semibold text-text-secondary uppercase tracking-widest">Innings Timeline</div>
              <div className="text-[10px] font-medium text-text-light">{liveHistory.length} balls</div>
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
                      <span className="text-text-light text-xs font-medium italic mr-2 whitespace-nowrap">Waiting for first ball...</span>
                    )}
                    
                    {over.map((ball, idx) => (
                      <motion.div 
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: ball.isUndone ? 0.4 : 1 }}
                        key={`ball-${overIdx}-${idx}`} 
                        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold
                          ${ball.isUndone ? 'bg-bg-muted text-text-light border border-dashed border-border-default' :
                            ball.isWicket ? 'bg-btn-wicket-bg text-status-wicket border border-status-wicket\/30' : 
                            ball.runs === 4 || ball.runs === 6 ? 'bg-status-live\/10 text-status-live border border-status-live\/30' : 
                            !ball.isLegal ? 'bg-btn-noball-bg text-accent-orange border border-accent-orange\/30' :
                            ball.runs === 0 ? 'bg-bg-muted text-text-light border border-border-default' : 'bg-bg-card text-text-primary border border-border-default'}
                        `}
                      >
                        {ball.label}
                      </motion.div>
                    ))}
                    
                    {Array.from({ length: emptySlotsCount }).map((_, idx) => (
                      <div key={`empty-${overIdx}-${idx}`} className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center border border-dashed border-border-default bg-bg-muted">
                        <div className="w-1 h-1 rounded-full bg-border-default"></div>
                      </div>
                    ))}

                    {overIdx < liveOversList.length - 1 && (
                      <div className="w-px h-6 bg-border-default mx-1 flex-shrink-0"></div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {(liveWickets >= 10 || liveBalls >= liveTotalOvers * 6) && liveCurrentInnings === 1 && !liveIsMatchOver && (
            <div className="bg-primary-navy text-text-white p-4 rounded-xl text-center text-sm font-bold uppercase tracking-wider">
              Innings Over! Waiting for scorer to start next innings.
            </div>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-card flex flex-col font-sans text-text-primary">
      {/* Header */}
      <header className="px-4 py-3 flex justify-between items-center sticky top-0 z-20 bg-bg-card border-b border-border-default">
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setCurrentView('dashboard')}
            className="p-2 rounded-lg text-text-secondary hover:bg-bg-muted hover:text-text-primary transition-colors"
            title="Back to Dashboard"
          >
            <RotateCcw className="w-4 h-4 rotate-180" />
          </button>
          <h2 className="text-lg font-bold leading-tight tracking-tight text-text-primary">{getBattingTeamName()}</h2>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={handleLogout}
            className="p-2 rounded-lg text-text-secondary hover:bg-bg-muted hover:text-text-primary transition-colors"
            title="Logout"
          >
            <LogOut className="w-4 h-4" />
          </button>
          <button 
            onClick={() => setShowHistory(!showHistory)}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-text-primary bg-bg-muted hover:bg-border-default transition-colors tracking-wide"
          >
            {showHistory ? 'SCORECARD' : 'HISTORY'}
          </button>
          <div className="bg-primary-navy px-3 py-1.5 rounded-lg">
            <span className="text-xs text-text-white font-bold tracking-wide">
              INNINGS {currentInnings}
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 p-4 max-w-md w-full mx-auto flex flex-col gap-4 relative z-10">
        {showHistory ? (
          // History View
          <div className="bg-bg-card border border-border-default rounded-xl p-6 flex-1 flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <h3 className="font-semibold text-xl tracking-tight">Over History</h3>
              <div className="text-[10px] font-medium text-text-secondary bg-bg-muted px-2 py-1 rounded-md">Tap to edit</div>
            </div>
            
            <div className="space-y-4 flex-1">
              {oversWithIndex.map(over => (
                <div key={over.overNumber} className="bg-bg-muted border border-border-default rounded-xl p-4">
                  <div className="flex justify-between items-center mb-3">
                    <div className="text-xs font-medium text-text-secondary">Over {over.overNumber}</div>
                    <div className="text-xs font-semibold text-text-primary">
                      {over.balls.reduce((acc, b) => acc + b.runs + b.extras, 0)} runs
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {over.balls.map(ball => (
                      <button
                        key={ball.originalIndex}
                        onClick={() => openEditModal(ball.originalIndex)}
                        className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-transform active:scale-95
                          ${ball.isWicket ? 'bg-btn-wicket-bg text-status-wicket border border-status-wicket\/30' : 
                            ball.runs === 4 || ball.runs === 6 ? 'bg-status-live\/10 text-status-live border border-status-live\/30' : 
                            !ball.isLegal ? 'bg-btn-noball-bg text-accent-orange border border-accent-orange\/30' :
                            ball.runs === 0 ? 'bg-bg-muted text-text-light border border-border-default' : 'bg-bg-card text-text-primary border border-border-default'}
                        `}
                      >
                        {ball.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {history.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-text-light py-12">
                  <div className="w-12 h-12 mb-3 rounded-full bg-bg-muted flex items-center justify-center">
                    <RotateCcw className="w-5 h-5 text-text-light" />
                  </div>
                  <p className="text-sm font-medium">No balls bowled yet</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Score Card */}
            <div className={`bg-bg-card border rounded-xl p-3 flex flex-col relative overflow-hidden shadow-sm transition-colors ${hasPowerOver && powerOvers[currentInnings] === Math.floor(balls / 6) ? 'border-primary-bright\/50 ring-2 ring-btn-wide-bg' : 'border-border-default'}`}>
              {hasPowerOver && powerOvers[currentInnings] === Math.floor(balls / 6) && (
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-primary-bright via-primary-blue to-primary-bright animate-pulse" />
              )}
              <div className="flex justify-between items-center w-full">
                <div className="flex flex-col">
                  <div className="flex items-center gap-2 mb-0.5">
                    <div className="text-text-light text-[9px] font-semibold uppercase tracking-widest">Total Score</div>
                    {hasPowerOver && powerOvers[currentInnings] === Math.floor(balls / 6) && (
                      <div className="flex items-center gap-1 text-[9px] font-bold text-primary-bright bg-btn-wide-bg px-1.5 py-0.5 rounded uppercase tracking-widest">
                        <Zap className="w-3 h-3 fill-current" />
                        Power Over
                      </div>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="text-5xl leading-none font-bold text-text-primary tracking-tighter">{runs}</span>
                    <span className="text-2xl font-light text-text-light mx-0.5">/</span>
                    <span className="text-3xl font-semibold text-text-secondary">{wickets}</span>
                  </div>
                </div>
                
                <div className="flex gap-4 text-right">
                  <div className="flex flex-col items-end">
                    <div className="text-text-light text-[9px] uppercase tracking-widest font-semibold mb-0.5">Overs</div>
                    <div className="text-2xl font-bold text-text-primary leading-none">{formatOvers(balls)}</div>
                  </div>
                  <div className="flex flex-col items-end">
                    <div className="text-text-light text-[9px] uppercase tracking-widest font-semibold mb-0.5">CRR</div>
                    <div className="text-2xl font-bold text-text-primary leading-none">
                      {balls > 0 ? ((runs / balls) * 6).toFixed(2) : '0.00'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Innings Progress */}
              <div className="mt-3 w-full">
                <div className="flex justify-between text-[9px] font-semibold text-text-secondary uppercase tracking-widest mb-1">
                  <span>Innings Progress</span>
                  <span>{balls} / {totalOvers * 6} Balls</span>
                </div>
                <div className="flex gap-1 w-full h-1">
                  {Array.from({ length: totalOvers }).map((_, overIdx) => {
                    const legalBallsInThisOver = Math.max(0, Math.min(6, balls - (overIdx * 6)));
                    const fillPercentage = (legalBallsInThisOver / 6) * 100;
                    
                    return (
                      <div key={overIdx} className="flex-1 bg-bg-muted rounded-full overflow-hidden relative">
                        <motion.div 
                          className="absolute top-0 left-0 h-full bg-primary-navy"
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
                <div className="mt-3 pt-3 border-t border-border-light w-full flex justify-between items-center">
                  <p className="text-[10px] font-medium text-text-secondary uppercase tracking-wider">
                    Target <span className="text-text-primary font-bold text-xs ml-1">{firstInningsScore.runs + 1}</span>
                  </p>
                  {!isMatchOver && (
                    <p className="text-[10px] font-semibold text-text-primary tracking-wide bg-bg-muted px-2 py-1 rounded border border-border-default">
                      Need {Math.max(0, firstInningsScore.runs + 1 - runs)} from {totalOvers * 6 - balls}
                    </p>
                  )}
                </div>
              )}
              
              {isMatchOver && (
                <div className="mt-3 pt-3 border-t border-border-light w-full text-center">
                  <div className="inline-flex items-center gap-1.5 bg-primary-navy text-text-white px-3 py-1.5 rounded-lg text-[10px] font-bold w-full justify-center uppercase tracking-wider">
                    <Trophy className="w-3 h-3" />
                    {runs > (firstInningsScore?.runs || 0) 
                      ? `${getBattingTeamName()} Won by ${10 - wickets} wkts!` 
                      : runs === (firstInningsScore?.runs || 0) 
                        ? "Match Tied!" 
                        : `${getBowlingTeamName()} Won by ${firstInningsScore!.runs - runs} runs!`}
                  </div>
                </div>
              )}
            </div>

            {/* Innings Timeline */}
            <div className="bg-bg-card border border-border-default rounded-xl p-3">
              <div className="flex justify-between items-center mb-2">
                <div className="text-[9px] font-semibold text-text-secondary uppercase tracking-widest">Innings Timeline</div>
                <div className="text-[9px] font-medium text-text-light">{history.length} balls</div>
              </div>
              <div 
                ref={timelineRef}
                className="flex gap-2 min-h-[32px] items-center overflow-x-auto pb-1 scrollbar-hide snap-x scroll-smooth"
              >
                {oversList.map((over, overIdx) => {
                  const legalBalls = over.filter(b => b.isLegal).length;
                  const showEmptySlots = overIdx === oversList.length - 1 && !isMatchOver && wickets < 10 && balls < totalOvers * 6;
                  const emptySlotsCount = showEmptySlots ? Math.max(0, 6 - legalBalls) : 0;

                  return (
                    <div key={overIdx} className="flex gap-1.5 items-center snap-end">
                      {over.length === 0 && overIdx === 0 && emptySlotsCount > 0 && (
                        <span className="text-text-light text-[10px] font-medium italic mr-1 whitespace-nowrap">Waiting for first ball...</span>
                      )}
                      
                      {over.map((ball, idx) => (
                        <motion.div 
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: ball.isUndone ? 0.4 : 1 }}
                          key={`ball-${overIdx}-${idx}`} 
                          className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold
                            ${ball.isUndone ? 'bg-bg-muted text-text-light border border-dashed border-border-default' :
                              ball.isWicket ? 'bg-btn-wicket-bg text-status-wicket border border-status-wicket\/30' : 
                              ball.runs === 4 || ball.runs === 6 ? 'bg-status-live\/10 text-status-live border border-status-live\/30' : 
                              !ball.isLegal ? 'bg-btn-noball-bg text-accent-orange border border-accent-orange\/30' :
                              ball.runs === 0 ? 'bg-bg-muted text-text-light border border-border-default' : 'bg-bg-card text-text-primary border border-border-default'}
                          `}
                        >
                          {ball.label}
                        </motion.div>
                      ))}
                      
                      {Array.from({ length: emptySlotsCount }).map((_, idx) => (
                        <div key={`empty-${overIdx}-${idx}`} className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center border border-dashed border-border-default bg-bg-muted">
                          <div className="w-1 h-1 rounded-full bg-border-default"></div>
                        </div>
                      ))}

                      {overIdx < oversList.length - 1 && (
                        <div className="w-px h-4 bg-border-default mx-0.5 flex-shrink-0"></div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {(wickets >= 10 || balls >= totalOvers * 6) && currentInnings === 1 && !isMatchOver && (
              <div className="bg-primary-navy text-text-white p-4 rounded-xl text-center text-sm font-bold uppercase tracking-wider">
                Innings Over! Declare to continue.
              </div>
            )}

            {/* Controls */}
            <div className="bg-bg-card border border-border-default rounded-xl p-4 mt-auto">
              <div className="flex justify-between items-center mb-3">
                <div className="text-xs font-bold text-text-light uppercase tracking-widest">Scoring</div>
                {hasPowerOver && !isMatchOver && wickets < 10 && balls < totalOvers * 6 && (
                  <button
                    onClick={togglePowerOver}
                    disabled={powerOvers[currentInnings] != null && powerOvers[currentInnings] !== Math.floor(balls / 6)}
                    className={`px-3 py-1.5 rounded-lg font-bold text-[10px] uppercase tracking-widest flex items-center gap-1.5 transition-colors border ${
                      powerOvers[currentInnings] === Math.floor(balls / 6)
                        ? 'bg-btn-wide-bg text-primary-navy border-primary-bright\/30'
                        : powerOvers[currentInnings] != null
                          ? 'bg-bg-muted text-text-light border-border-default cursor-not-allowed'
                          : 'bg-bg-card text-primary-bright border-primary-bright\/30 hover:bg-btn-wide-bg'
                    }`}
                  >
                    <Zap className="w-3 h-3" />
                    {powerOvers[currentInnings] === Math.floor(balls / 6) 
                      ? 'Power Over Active' 
                      : powerOvers[currentInnings] != null 
                        ? 'Power Over Used' 
                        : 'Activate Power Over'}
                  </button>
                )}
              </div>
              
              {!isMatchOver && wickets < 10 && balls < totalOvers * 6 && (
                <>
                  {isNbMode && (
                    <div className="text-center mb-3 text-[10px] font-bold text-accent-orange uppercase tracking-widest animate-pulse bg-btn-noball-bg py-2 rounded-lg border border-accent-orange\/30">
                      Select runs scored off No Ball
                    </div>
                  )}
                  <div className="grid grid-cols-4 gap-2 mb-2">
                    {[0, 1, 2, 3].map(r => (
                      <button
                        key={r}
                        onClick={() => handleRunClick(r)}
                        className="py-5 rounded-xl font-bold text-2xl bg-bg-card text-text-primary hover:bg-bg-muted border-2 border-border-default transition-colors active:bg-border-default shadow-sm"
                      >
                        {r}
                      </button>
                    ))}
                    <button
                      onClick={() => handleRunClick(4)}
                      className="py-5 rounded-xl font-bold text-2xl bg-bg-card text-status-live hover:bg-status-live\/10 border-2 border-status-live\/30 transition-colors active:bg-status-live\/20 shadow-sm"
                    >
                      4
                    </button>
                    <button
                      onClick={() => handleRunClick(6)}
                      className="py-5 rounded-xl font-bold text-2xl bg-status-live text-text-white hover:bg-status-live\/90 transition-colors active:bg-status-live\/80 shadow-sm"
                    >
                      6
                    </button>
                    <button
                      onClick={() => {
                        addBall(0, false, false, 'Wd', 1);
                        setIsNbMode(false);
                      }}
                      className="py-5 rounded-xl font-bold text-xl bg-bg-card text-text-primary hover:bg-bg-muted border-2 border-border-default transition-colors active:bg-border-default shadow-sm"
                    >
                      Wd
                    </button>
                    <button
                      onClick={() => setIsNbMode(m => !m)}
                      className={`py-5 rounded-xl font-bold text-xl border-2 transition-colors shadow-sm ${
                        isNbMode 
                          ? 'bg-accent-orange text-text-white border-accent-orange active:bg-accent-orange\/80' 
                          : 'bg-bg-card text-accent-orange hover:bg-btn-noball-bg border-accent-orange\/30 active:bg-btn-noball-bg\/80'
                      }`}
                    >
                      NB
                    </button>
                  </div>
                </>
              )}
              
              <div className="grid grid-cols-4 gap-2 mt-2">
                {!isMatchOver && wickets < 10 && balls < totalOvers * 6 && (
                  <button
                    onClick={handleWicketClick}
                    className="col-span-2 py-4 rounded-xl font-bold text-base bg-status-wicket text-text-white hover:bg-status-wicket\/90 transition-colors active:bg-status-wicket\/80 tracking-widest shadow-sm"
                  >
                    WICKET
                  </button>
                )}
                <button
                  onClick={undo}
                  disabled={history.length === 0}
                  className={`py-4 rounded-xl font-bold text-xs bg-primary-navy text-text-white hover:bg-primary-blue disabled:opacity-40 disabled:cursor-not-allowed flex flex-col items-center justify-center gap-1 transition-colors active:bg-primary-blue tracking-widest shadow-sm ${isMatchOver || wickets >= 10 || balls >= totalOvers * 6 ? 'col-span-2 flex-row' : 'col-span-1'}`}
                >
                  <RotateCcw className="w-4 h-4" />
                  UNDO
                </button>
                <button
                  onClick={redo}
                  disabled={redoStack.length === 0}
                  className={`py-4 rounded-xl font-bold text-xs bg-primary-navy text-text-white hover:bg-primary-blue disabled:opacity-40 disabled:cursor-not-allowed flex flex-col items-center justify-center gap-1 transition-colors active:bg-primary-blue tracking-widest shadow-sm ${isMatchOver || wickets >= 10 || balls >= totalOvers * 6 ? 'col-span-2 flex-row' : 'col-span-1'}`}
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
                  className="flex-1 bg-bg-card border border-border-default text-text-primary font-bold py-3 px-4 rounded-xl hover:bg-bg-muted transition-colors active:bg-border-default flex items-center justify-center gap-2 tracking-widest text-sm"
                >
                  DECLARE INNINGS
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}
              
              {isMatchOver && (
                <button
                  onClick={resetMatch}
                  className="flex-1 bg-primary-navy text-text-white font-bold py-3 px-4 rounded-xl hover:bg-primary-blue transition-colors active:bg-primary-blue flex items-center justify-center gap-2 tracking-widest text-sm"
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
        <div className="fixed inset-0 bg-primary-navy/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-bg-card border border-border-default rounded-2xl p-6 w-full max-w-sm shadow-xl">
            <h3 className="font-bold text-xl text-text-primary mb-1 tracking-tight">Edit Delivery</h3>
            <p className="text-sm font-medium text-text-secondary mb-6">Update the details for this ball.</p>
            
            <div className="space-y-6 mb-8">
              {/* Runs */}
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">Runs Scored</label>
                <div className="grid grid-cols-6 gap-2">
                  {[0, 1, 2, 3, 4, 6].map(r => (
                    <button
                      key={r}
                      onClick={() => setEditRuns(r)}
                      className={`py-2 rounded-lg font-bold text-sm border transition-all ${editRuns === r ? 'bg-primary-navy text-text-white border-primary-navy' : 'bg-bg-card text-text-primary border-border-default hover:bg-bg-muted'}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              {/* Extras */}
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">Delivery Type</label>
                <div className="flex gap-2">
                  <button 
                    onClick={() => setEditExtraType('none')}
                    className={`flex-1 py-2 rounded-lg font-bold text-sm border transition-all ${editExtraType === 'none' ? 'bg-primary-navy text-text-white border-primary-navy' : 'bg-bg-card text-text-primary border-border-default hover:bg-bg-muted'}`}
                  >
                    Legal
                  </button>
                  <button 
                    onClick={() => setEditExtraType('wd')}
                    className={`flex-1 py-2 rounded-lg font-bold text-sm border transition-all ${editExtraType === 'wd' ? 'bg-primary-navy text-text-white border-primary-navy' : 'bg-bg-card text-text-primary border-border-default hover:bg-bg-muted'}`}
                  >
                    Wide
                  </button>
                  <button 
                    onClick={() => setEditExtraType('nb')}
                    className={`flex-1 py-2 rounded-lg font-bold text-sm border transition-all ${editExtraType === 'nb' ? 'bg-primary-navy text-text-white border-primary-navy' : 'bg-bg-card text-text-primary border-border-default hover:bg-bg-muted'}`}
                  >
                    No Ball
                  </button>
                </div>
              </div>

              {/* Wicket */}
              <div>
                <label className="block text-xs font-semibold text-text-secondary uppercase tracking-wider mb-3">Wicket</label>
                <button
                  onClick={() => setEditIsWicket(!editIsWicket)}
                  className={`w-full py-2 rounded-lg font-bold text-sm border transition-all ${editIsWicket ? 'bg-status-wicket text-text-white border-status-wicket' : 'bg-bg-card text-text-primary border-border-default hover:bg-bg-muted'}`}
                >
                  {editIsWicket ? 'WICKET FALLEN' : 'NO WICKET'}
                </button>
              </div>
            </div>
            
            <div className="flex gap-3">
              <button 
                onClick={() => setEditingBallIndex(null)}
                className="flex-1 py-3 rounded-lg font-bold text-sm bg-bg-card text-text-primary border border-border-default hover:bg-bg-muted transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={saveEditedBall}
                className="flex-1 py-3 rounded-lg font-bold text-sm bg-primary-navy text-text-white hover:bg-primary-blue transition-all"
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
