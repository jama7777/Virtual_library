import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";

// Types
interface Book {
  key: string;
  title: string;
  author_name?: string[];
  cover_i?: number;
  first_publish_year?: number;
}

interface Holding {
  library: string;
  address: string;
  callNumber: string;
  availability: string;
  directions: string;
  website?: string;
}

interface SearchCache {
  [query: string]: Book[];
}

// Fallback map key from prompt instructions
const MAP_KEY = "AIzaSyBKjQyne1QMdWLK0qoZb49jaq8DHHTF3XY";

const App: React.FC = () => {
  const [query, setQuery] = useState('');
  const [books, setBooks] = useState<Book[]>([]);
  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);
  const [holdingsLoading, setHoldingsLoading] = useState(false);
  const [error, setError] = useState('');
  const [location, setLocation] = useState<string>('Major Libraries (Global)');
  const [voiceListening, setVoiceListening] = useState(false);
  const [groundingUrls, setGroundingUrls] = useState<{title: string, uri: string}[]>([]);
  
  // Shelf Visualization State
  const [shelfImages, setShelfImages] = useState<{[key: number]: string}>({});
  const [loadingShelfIndex, setLoadingShelfIndex] = useState<number | null>(null);

  // Refs for voice recognition
  const recognitionRef = useRef<any>(null);

  // Load cache on mount
  useEffect(() => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(async (position) => {
        setLocation(`${position.coords.latitude}, ${position.coords.longitude}`);
      }, () => {
        console.log("Geolocation denied or unavailable, using default.");
      });
    }

    // Setup Voice Recognition
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.lang = 'en-US';
      recognitionRef.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setQuery(transcript);
        handleSearch(transcript);
        setVoiceListening(false);
      };
      recognitionRef.current.onerror = () => setVoiceListening(false);
      recognitionRef.current.onend = () => setVoiceListening(false);
    }
  }, []);

  const toggleVoice = () => {
    if (!recognitionRef.current) return;
    if (voiceListening) {
      recognitionRef.current.stop();
    } else {
      recognitionRef.current.start();
      setVoiceListening(true);
    }
  };

  const checkCache = (q: string): Book[] | null => {
    const cached = localStorage.getItem('globalLib_cache');
    if (cached) {
      const parsed: SearchCache = JSON.parse(cached);
      return parsed[q.toLowerCase()] || null;
    }
    return null;
  };

  const updateCache = (q: string, results: Book[]) => {
    const cached = localStorage.getItem('globalLib_cache');
    const parsed: SearchCache = cached ? JSON.parse(cached) : {};
    parsed[q.toLowerCase()] = results;
    localStorage.setItem('globalLib_cache', JSON.stringify(parsed));
  };

  const handleSearch = async (searchQuery: string = query) => {
    if (!searchQuery.trim()) return;
    setError('');
    setSelectedBook(null);
    setHoldings([]);
    setShelfImages({});
    
    // Check Cache
    const cachedResults = checkCache(searchQuery);
    if (cachedResults) {
      setBooks(cachedResults);
      return;
    }

    setLoading(true);
    try {
      // 1. Open Library API (Keyless)
      const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(searchQuery)}&fields=key,title,author_name,cover_i,first_publish_year&limit=12`);
      if (!res.ok) throw new Error("Failed to fetch from Open Library");
      
      const data = await res.json();
      if (data.docs && data.docs.length > 0) {
        setBooks(data.docs);
        updateCache(searchQuery, data.docs);
      } else {
        setBooks([]);
        setError(`Not found? Try searching for "Dune" or "1984".`);
      }
    } catch (err) {
      setError("Library systems offline. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  const fetchHoldings = async (book: Book) => {
    setHoldingsLoading(true);
    setHoldings([]);
    setGroundingUrls([]);
    setShelfImages({});
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // 3. Gemini with Google Search Grounding for Real-time Availability
      // Updated prompt to ask for specific indoor directions (Floor/Room)
      const prompt = `Find physical library holdings for the book "${book.title}" by ${book.author_name?.[0] || 'Unknown'}. 
      Prioritize major libraries like NYPL, British Library, Library of Congress, or major public libraries near ${location}.
      
      Return a JSON array of objects with these keys: 
      - "library" (Name of library)
      - "address" (Full street address)
      - "callNumber" (Specific shelf location/Call Number, e.g., 'J F ROWLING', 'LCCN 2020')
      - "availability" (e.g., 'Available', 'Reference Only', 'Checked Out')
      - "directions" (Specific INDOOR walking directions. Mention the Floor, Room, or Section name if known. e.g. "3rd Floor, Rose Reading Room, Aisle 4")
      - "website" (URL to reserve or view catalog if found)
      
      Strictly output JSON only in a code block. Limit to top 3 relevant libraries.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        }
      });

      // Extract Grounding URLs
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (chunks) {
        const urls = chunks
          .filter(c => c.web?.uri && c.web?.title)
          .map(c => ({ title: c.web!.title!, uri: c.web!.uri! }));
        setGroundingUrls(urls);
      }

      const text = response.text;
      
      // Parse JSON from Markdown code block
      const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/```([\s\S]*?)```/) || [null, text];
      let parsedHoldings: Holding[] = [];
      
      try {
        if (jsonMatch[1]) {
           parsedHoldings = JSON.parse(jsonMatch[1]);
        } else {
           parsedHoldings = JSON.parse(text);
        }
      } catch (e) {
        console.error("Failed to parse GenAI response", e);
        setError("Could not parse library data. Try again.");
      }

      setHoldings(parsedHoldings);
    } catch (err) {
      console.error(err);
      setError("Could not retrieve real-time holdings. Please try again.");
    } finally {
      setHoldingsLoading(false);
    }
  };

  // Generate a visual guide for the shelf
  const generateShelfView = async (library: string, callNumber: string, index: number) => {
    if (shelfImages[index] || loadingShelfIndex !== null) return;
    setLoadingShelfIndex(index);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const prompt = `A photorealistic wide shot of a library aisle inside ${library}. 
      The view focuses on a specific bookshelf containing books with call number "${callNumber}". 
      The scene should show the interior of this specific library (e.g. if NYPL, show classical architecture; if modern, show metal shelves).
      Highlight or focus on the middle shelf where the book would be. 
      Warm library lighting, academic atmosphere. No text overlay.`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [{ text: prompt }]
        }
      });

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          const base64String = part.inlineData.data;
          const mimeType = part.inlineData.mimeType || 'image/png';
          setShelfImages(prev => ({...prev, [index]: `data:${mimeType};base64,${base64String}`}));
        }
      }
    } catch (e) {
      console.error("Failed to generate shelf image", e);
    } finally {
      setLoadingShelfIndex(null);
    }
  };

  const handleBookSelect = (book: Book) => {
    setSelectedBook(book);
    fetchHoldings(book);
    // Scroll to details
    setTimeout(() => {
      document.getElementById('details-view')?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  return (
    <div className="min-h-screen wood-texture text-amber-50 font-sans selection:bg-amber-500 selection:text-white">
      {/* Header */}
      <header className="p-6 border-b-4 border-amber-900/50 bg-stone-900/90 shadow-lg sticky top-0 z-20 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-3">
             <div className="text-4xl">📚</div>
             <div>
               <h1 className="text-2xl font-serif font-bold tracking-wider text-amber-400">GlobalLib Navigator <span className="text-xs bg-amber-700 text-white px-2 py-0.5 rounded-full align-middle">Free</span></h1>
               <p className="text-xs text-amber-200/60">Keyless AI Search • Public Libraries • Real-time</p>
             </div>
          </div>
          
          <div className="relative w-full md:w-96 group">
            <input 
              type="text" 
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search title, author, or ISBN..."
              className="w-full bg-stone-800 border-2 border-amber-800/50 rounded-lg py-2 pl-4 pr-12 text-amber-100 placeholder-amber-700/50 focus:outline-none focus:border-amber-500 focus:shadow-[0_0_15px_rgba(245,158,11,0.2)] transition-all"
            />
            <button 
              onClick={() => handleSearch()}
              className="absolute right-10 top-1/2 -translate-y-1/2 text-amber-600 hover:text-amber-400 p-1"
            >
              🔍
            </button>
            <button 
              onClick={toggleVoice}
              className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full transition-colors ${voiceListening ? 'text-red-500 animate-pulse' : 'text-amber-600 hover:text-amber-400'}`}
              title="Voice Search"
            >
              🎤
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto p-6 pb-20">
        {/* Error Message */}
        {error && (
          <div className="bg-red-900/50 border border-red-500/30 text-red-200 p-4 rounded-lg mb-6 text-center animate-fade-in">
            {error}
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="text-center py-12">
            <div className="inline-block text-4xl animate-bounce">📖</div>
            <p className="text-amber-700 mt-2 font-serif italic">Consulting the archives...</p>
          </div>
        )}

        {/* Book Grid */}
        {!selectedBook && !loading && books.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 animate-fade-in-up">
            {books.map((book) => (
              <div 
                key={book.key}
                onClick={() => handleBookSelect(book)}
                className="bg-stone-800/80 border border-stone-700 p-3 rounded shadow-xl hover:scale-105 hover:border-amber-500/50 hover:book-glow transition-all cursor-pointer group"
              >
                <div className="aspect-[2/3] bg-stone-900 mb-3 rounded overflow-hidden relative shadow-inner">
                  {book.cover_i ? (
                    <img 
                      src={`https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg`} 
                      alt={book.title}
                      className="w-full h-full object-cover opacity-90 group-hover:opacity-100 transition-opacity"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-stone-700 text-4xl font-serif">?</div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-60"></div>
                </div>
                <h3 className="font-serif font-bold text-amber-100 leading-tight line-clamp-2 mb-1">{book.title}</h3>
                <p className="text-xs text-amber-500/80 truncate">{book.author_name?.join(', ') || 'Unknown Author'}</p>
                <p className="text-[10px] text-stone-500 mt-1">{book.first_publish_year}</p>
              </div>
            ))}
          </div>
        )}

        {/* Detail View */}
        {selectedBook && (
          <div id="details-view" className="animate-fade-in">
            <button 
              onClick={() => setSelectedBook(null)}
              className="mb-4 text-amber-600 hover:text-amber-400 flex items-center gap-2 text-sm font-bold uppercase tracking-widest"
            >
              ← Back to Stacks
            </button>

            <div className="bg-stone-900/90 border border-amber-900/50 rounded-lg overflow-hidden shadow-2xl">
              {/* Book Header */}
              <div className="p-6 md:p-8 flex flex-col md:flex-row gap-8 border-b border-stone-800">
                <div className="w-32 md:w-48 flex-shrink-0 shadow-2xl rotate-1">
                  {selectedBook.cover_i ? (
                    <img 
                      src={`https://covers.openlibrary.org/b/id/${selectedBook.cover_i}-L.jpg`} 
                      alt={selectedBook.title}
                      className="w-full rounded border-r-4 border-stone-950"
                    />
                  ) : (
                    <div className="w-full aspect-[2/3] bg-stone-800 flex items-center justify-center rounded">No Cover</div>
                  )}
                </div>
                <div className="flex-1">
                  <h2 className="text-3xl md:text-4xl font-serif font-bold text-amber-100 mb-2">{selectedBook.title}</h2>
                  <p className="text-xl text-amber-500 mb-4 font-serif italic">{selectedBook.author_name?.join(', ')}</p>
                  <p className="text-stone-400 text-sm max-w-prose">
                    Published: {selectedBook.first_publish_year}. Found via Open Library. 
                    Checking global library systems for physical copies...
                  </p>
                  
                  {/* Digital Link */}
                  <div className="mt-6">
                    <a 
                      href={`https://openlibrary.org${selectedBook.key}`}
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2 bg-stone-800 hover:bg-stone-700 text-amber-200 text-sm rounded border border-stone-600 transition-colors"
                    >
                      <span>🌐</span> View Digital Preview
                    </a>
                  </div>
                </div>
              </div>

              {/* Holdings Section */}
              <div className="p-6 md:p-8 bg-stone-950/30">
                <h3 className="text-xl font-serif text-amber-200 mb-6 flex items-center gap-2">
                  <span>🏛️</span> Physical Holdings & Availability
                </h3>

                {holdingsLoading ? (
                  <div className="space-y-4 animate-pulse">
                     <div className="h-4 bg-stone-800 rounded w-3/4"></div>
                     <div className="h-4 bg-stone-800 rounded w-1/2"></div>
                     <div className="h-4 bg-stone-800 rounded w-5/6"></div>
                     <p className="text-xs text-amber-700 mt-2">Connecting to Gemini Search Grounding...</p>
                  </div>
                ) : holdings.length > 0 ? (
                  <div className="space-y-8">
                    {holdings.map((lib, idx) => (
                      <div key={idx} className="bg-stone-900 border border-stone-700 rounded-lg overflow-hidden flex flex-col md:flex-row">
                         {/* Info Column */}
                         <div className="p-5 flex-1">
                            <div className="flex justify-between items-start mb-2">
                               <h4 className="font-bold text-lg text-amber-100">{lib.library}</h4>
                               <span className={`text-xs px-2 py-1 rounded font-bold uppercase ${
                                 lib.availability?.toLowerCase().includes('available') ? 'bg-green-900 text-green-200' : 'bg-red-900 text-red-200'
                               }`}>
                                 {lib.availability}
                               </span>
                            </div>
                            <p className="text-sm text-stone-400 mb-4">{lib.address}</p>
                            
                            <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                              <div className="bg-stone-950 p-2 rounded border border-stone-800">
                                <span className="block text-stone-500 text-xs uppercase">Call Number</span>
                                <span className="font-mono text-amber-400">{lib.callNumber || 'N/A'}</span>
                              </div>
                              <div className="bg-stone-950 p-2 rounded border border-stone-800 cursor-help" title={lib.directions}>
                                <span className="block text-stone-500 text-xs uppercase">Location</span>
                                <span className="text-stone-300 truncate">{lib.directions.split(',')[0]}...</span>
                              </div>
                            </div>

                            <div className="mb-4">
                              <span className="block text-stone-500 text-xs uppercase mb-1">Indoor Directions</span>
                              <p className="text-sm text-amber-100/80 italic border-l-2 border-amber-600 pl-3">
                                "{lib.directions}"
                              </p>
                            </div>

                            <div className="flex items-center gap-3">
                              {lib.website && (
                                <a href={lib.website} target="_blank" rel="noreferrer" className="text-xs px-3 py-1 bg-stone-800 border border-stone-600 rounded text-amber-500 hover:text-amber-300">
                                  Library Catalog
                                </a>
                              )}
                              
                              {/* Shelf Visualizer Button */}
                              <button 
                                onClick={() => generateShelfView(lib.library, lib.callNumber, idx)}
                                disabled={loadingShelfIndex !== null || !!shelfImages[idx]}
                                className="text-xs px-3 py-1 bg-amber-900/50 border border-amber-700 rounded text-amber-200 hover:bg-amber-800/50 disabled:opacity-50 flex items-center gap-1 transition-colors"
                              >
                                {shelfImages[idx] ? 'Visualized' : loadingShelfIndex === idx ? 'Generating...' : '👁️ View Shelf Guide'}
                              </button>
                            </div>

                            {/* Generated Shelf Image */}
                            {shelfImages[idx] && (
                              <div className="mt-4 animate-fade-in relative group">
                                <div className="text-[10px] text-stone-400 uppercase mb-1 flex justify-between">
                                  <span>AI Generated Shelf Location</span>
                                  <span className="text-amber-600">Prediction</span>
                                </div>
                                <div className="rounded overflow-hidden border border-amber-500/30 relative">
                                  <img src={shelfImages[idx]} alt="AI Generated Shelf View" className="w-full h-48 object-cover hover:scale-105 transition-transform duration-700" />
                                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent pointer-events-none"></div>
                                  <div className="absolute bottom-2 left-2 text-white text-xs drop-shadow-md">
                                    📍 Aim for Call Number: <span className="font-mono font-bold text-amber-400">{lib.callNumber}</span>
                                  </div>
                                </div>
                              </div>
                            )}

                         </div>

                         {/* Map Column */}
                         <div className="md:w-64 h-48 md:h-auto bg-stone-800 relative border-t md:border-t-0 md:border-l border-stone-700 flex-shrink-0">
                           <iframe
                             width="100%"
                             height="100%"
                             frameBorder="0"
                             style={{ border: 0, filter: 'sepia(40%) contrast(1.1)' }}
                             src={`https://www.google.com/maps/embed/v1/place?key=${MAP_KEY}&q=${encodeURIComponent(lib.address)}`}
                             allowFullScreen
                           ></iframe>
                           <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-[10px] text-white p-1 text-center backdrop-blur-sm">
                             Exterior Map
                           </div>
                         </div>
                      </div>
                    ))}
                  </div>
                ) : (
                   <div className="text-stone-400 italic">
                      No physical copies found nearby. Try checking the <a href={`https://openlibrary.org${selectedBook.key}`} target="_blank" className="text-amber-500 underline">digital archive</a>.
                   </div>
                )}
                
                {/* Grounding Sources */}
                {groundingUrls.length > 0 && (
                  <div className="mt-6 pt-4 border-t border-stone-800">
                    <p className="text-xs text-stone-500 mb-2">Information sourced from:</p>
                    <ul className="text-xs space-y-1">
                      {groundingUrls.map((url, i) => (
                        <li key={i}>
                          <a href={url.uri} target="_blank" rel="noopener noreferrer" className="text-amber-700 hover:text-amber-500 truncate block">
                            {url.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-amber-900/30 bg-stone-900/50 text-center py-6 mt-auto">
        <p className="text-stone-600 text-xs">
          Powered by Open Library, Library of Congress, & Google Gemini • <span className="font-mono">GlobalLib v1.0</span>
        </p>
      </footer>
    </div>
  );
};

export default App;