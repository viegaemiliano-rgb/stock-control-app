import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, onSnapshot, query, addDoc, updateDoc, deleteDoc, doc, writeBatch, setDoc, getDocs } from 'firebase/firestore';

// --- CONFIGURACIÓN GLOBAL DE FIREBASE (PROPORCIONADA POR EL ENTORNO) ---
// NOTA: Para producción en tu propio hosting, reemplaza estas variables 
// con tu configuración de Firebase real (ver guía de hosting anterior).
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
const apiKey = ""; // API Key para Gemini (se usa la provista por el entorno)
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

// Umbral por defecto para nuevos artículos, ahora se puede personalizar por item
const DEFAULT_ALARM_DAYS = 7; 

// Lista de Categorías disponibles
const CATEGORIES = [
    'General',
    'Bebidas',
    'Alimentos Secos',
    'Lácteos',
    'Fiambres y Embutidos',
    'Quesos',
    'Refrigerados',
    'Congelados',
    'Limpieza',
    'Otros'
];

// Función auxiliar para validar y limpiar la categoría
const normalizeCategory = (cat) => {
    const normalizedCat = cat.trim().toLowerCase();
    const match = CATEGORIES.find(c => c.toLowerCase() === normalizedCat);
    return match || CATEGORIES[0]; // Retorna la categoría si hay coincidencia, sino 'General'
};

// FUNCIÓN DE SANITIZACIÓN: Sanitiza el nombre para usarlo como ID de documento en Firestore
const sanitizeDocId = (name) => {
    // Reemplaza todas las barras diagonales (/) con un guion bajo (_)
    return name.replace(/\//g, '_');
};

// Componente principal de la aplicación
const App = () => {
  const [items, setItems] = useState([]);
  const [commonNames, setCommonNames] = useState([]); // Estado para nombres comunes
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  
  const [newItem, setNewItem] = useState({ 
    name: '', 
    quantity: 1, 
    expirationDate: '', 
    alarmDays: DEFAULT_ALARM_DAYS, 
    category: CATEGORIES[0] 
  });
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState(null);
  const [editingItem, setEditingItem] = useState(null);
  const [showUrgentModal, setShowUrgentModal] = useState(false); 
  const [showImportModal, setShowImportModal] = useState(false);
  const [importData, setImportData] = useState(''); 
  
  const [geminiLoading, setGeminiLoading] = useState(false);
  const [geminiResponse, setGeminiResponse] = useState(null);
  const [showGeminiModal, setShowGeminiModal] = useState(false);

  // 1. Inicialización de Firebase y Autenticación
  useEffect(() => {
    if (Object.keys(firebaseConfig).length === 0) {
      setErrorMessage("Error: La configuración de Firebase no está disponible.");
      setLoading(false);
      return;
    }

    try {
      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const authInstance = getAuth(app);
      setDb(firestore);
      setAuth(authInstance);

      const unsubscribe = onAuthStateChanged(authInstance, (user) => {
        if (user) {
          setUserId(user.uid);
        } else {
          const authenticate = async () => {
            try {
              if (initialAuthToken) {
                await signInWithCustomToken(authInstance, initialAuthToken);
              } else {
                await signInAnonymously(authInstance);
              }
            } catch (error) {
              console.error("Error durante la autenticación de Firebase:", error);
              setUserId(crypto.randomUUID());
            }
            setIsAuthReady(true);
          };
          authenticate();
        }
      });

      return () => unsubscribe();
    } catch (error) {
      console.error("Error al inicializar Firebase:", error);
      setErrorMessage("Error de inicialización de Firebase.");
      setLoading(false);
    }
  }, []);

  // Función de lógica para determinar el estado de caducidad
  const checkExpirationStatus = useCallback((dateString, thresholdDays) => {
    const expirationTime = new Date(dateString).getTime();
    const currentTime = new Date().getTime();
    const diffMs = expirationTime - currentTime;
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    let status = 'OK'; // Verde
    let message = `${diffDays} días restantes`;

    if (diffDays < 0) {
      status = 'Expired'; // Rojo
      message = `VENCIDO hace ${Math.abs(diffDays)} días`;
    } else if (diffDays <= thresholdDays) { 
      status = 'Warning'; // Amarillo/Naranja (Alarma)
      message = `¡ALARMA! Vence en ${diffDays} días (Umbral: ${thresholdDays} días)`;
    }

    return { status, days: diffDays, message };
  }, []);

  // 2. Suscripción a la Base de Datos de STOCK
  useEffect(() => {
    if (!db || !isAuthReady || !userId) return;

    setLoading(true);
    // Path: /artifacts/{appId}/users/{userId}/stock_items
    const itemsCollectionRef = collection(db, 'artifacts', appId, 'users', userId, 'stock_items');
    const q = query(itemsCollectionRef);

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedItems = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        quantity: parseInt(doc.data().quantity, 10),
        alarmDays: parseInt(doc.data().alarmDays, 10) || DEFAULT_ALARM_DAYS,
        category: doc.data().category || CATEGORIES[0], 
      }));

      fetchedItems.sort((a, b) => new Date(a.expirationDate).getTime() - new Date(b.expirationDate).getTime());

      setItems(fetchedItems);
      setLoading(false);
    }, (error) => {
      console.error("Error al obtener datos de Firestore:", error);
      setErrorMessage("No se pudieron cargar los artículos.");
      setLoading(false);
    });

    return () => unsubscribe();
  }, [db, isAuthReady, userId]);
  
  // 3. Suscripción a la Base de Datos de NOMBRES COMUNES
  useEffect(() => {
    if (!db || !isAuthReady || !userId) return;

    // Path: /artifacts/{appId}/users/{userId}/common_names
    const namesCollectionRef = collection(db, 'artifacts', appId, 'users', userId, 'common_names');
    const q = query(namesCollectionRef);

    const unsubscribe = onSnapshot(q, (snapshot) => {
        // Se asegura de obtener el nombre original guardado en el campo 'name' del documento
        const fetchedNames = snapshot.docs.map(doc => doc.data().name); 
        setCommonNames(fetchedNames);
    }, (error) => {
        console.error("Error al obtener nombres comunes:", error);
    });

    return () => unsubscribe();
  }, [db, isAuthReady, userId]);


  // Generar lista UNIFICADA de nombres únicos para el autocompletado
  const uniqueItemNames = useMemo(() => {
    const namesFromStock = items.map(item => item.name.trim());
    const combinedNames = new Set([...namesFromStock, ...commonNames]);
    return Array.from(combinedNames).sort((a, b) => a.localeCompare(b));
  }, [items, commonNames]);
  
  // Manejar el cambio de input del formulario de CREACIÓN
  const handleInputChange = (e) => {
    const { name, value } = e.target;
    let newValue = value;
    
    if (name === 'quantity' || name === 'alarmDays') {
        newValue = Math.max(1, parseInt(value, 10) || 1);
    }

    setNewItem(prev => ({ ...prev, [name]: newValue }));
  };
  
  // Manejar el cambio de input del formulario de EDICIÓN
  const handleEditChange = (e) => {
    const { name, value } = e.target;
    let newValue = value;

    if (name === 'quantity' || name === 'alarmDays') {
        newValue = Math.max(1, parseInt(value, 10) || 1);
    }
    
    setEditingItem(prev => ({ ...prev, [name]: newValue }));
  };

  // Guardar un nuevo nombre en la lista de Nombres Comunes (al crear un artículo nuevo no listado)
  const saveCommonName = async (name) => {
    if (!db || !userId || !name) return;
    const trimmedName = name.trim();
    if (trimmedName && !commonNames.includes(trimmedName)) {
        try {
            const namesCollectionRef = collection(db, 'artifacts', appId, 'users', userId, 'common_names');
            const docId = sanitizeDocId(trimmedName); // Sanitize para el ID
            // Usamos el ID sanitizado, pero guardamos el nombre original en el campo 'name'
            await setDoc(doc(namesCollectionRef, docId), { name: trimmedName }); 
        } catch (error) {
            console.error("Error al guardar nombre común:", error);
        }
    }
  }

  // Agregar un nuevo artículo
  const addItem = async (e) => {
    e.preventDefault();
    if (!db || !userId) return;

    if (!newItem.name || !newItem.expirationDate || newItem.quantity <= 0 || newItem.alarmDays <= 0) {
      setErrorMessage("Por favor, complete todos los campos requeridos correctamente.");
      return;
    }
    setErrorMessage(null);

    const trimmedName = newItem.name.trim();

    try {
      const itemsCollectionRef = collection(db, 'artifacts', appId, 'users', userId, 'stock_items');
      await addDoc(itemsCollectionRef, {
        name: trimmedName, 
        quantity: newItem.quantity,
        expirationDate: newItem.expirationDate, 
        alarmDays: newItem.alarmDays, 
        category: newItem.category, 
        createdAt: new Date().toISOString()
      });
      // Añade el nombre a la lista de nombres comunes si es un artículo nuevo
      saveCommonName(trimmedName);
      
      // Restablecer el formulario 
      setNewItem({ name: '', quantity: 1, expirationDate: '', alarmDays: DEFAULT_ALARM_DAYS, category: CATEGORIES[0] }); 
    } catch (error) {
      console.error("Error al agregar artículo:", error);
      setErrorMessage("Error al guardar el artículo.");
    }
  };

  // Función: Solo guarda nombres únicos (para el modal de importación)
  const handleImport = async () => {
    if (!db || !userId || !importData.trim()) {
        setErrorMessage("No hay datos para importar o Firebase no está listo.");
        return;
    }
    setLoading(true);
    setErrorMessage(null);

    const lines = importData.trim().split('\n');
    const namesCollectionRef = collection(db, 'artifacts', appId, 'users', userId, 'common_names');
    const batch = writeBatch(db);
    let successCount = 0;
    let errorCount = 0;
    const namesToSave = new Set();
    
    // 1. Extraer nombres únicos de la importación
    for (const line of lines) {
        // Intenta dividir por tabulación o coma
        const values = line.split('\t').length > 1 ? line.split('\t') : line.split(',');
        const name = values[0]?.trim();

        if (name) {
            namesToSave.add(name);
            successCount++;
        } else {
            errorCount++;
        }
    }

    // 2. Guardar nombres en el batch de Firestore (usando setDoc para evitar duplicados)
    namesToSave.forEach(name => {
        const docId = sanitizeDocId(name); // Sanitize para el ID
        // Usamos el ID sanitizado, pero guardamos el nombre original en el campo 'name'
        batch.set(doc(namesCollectionRef, docId), { name: name }); 
    });


    try {
        await batch.commit();
        setImportData('');
        setShowImportModal(false);
        setErrorMessage(`Importación de nombres completada: ${namesToSave.size} nombres únicos agregados/actualizados. ${errorCount} líneas ignoradas.`);
    } catch (error) {
        console.error("Error al ejecutar el lote de Firestore:", error);
        setErrorMessage(`Error grave al guardar los nombres comunes en Firestore. ${error}`);
    } finally {
        setLoading(false);
    }
  };


  // Actualizar un artículo existente
  const updateItem = async (e) => {
    e.preventDefault();
    if (!db || !userId || !editingItem) return;

    if (!editingItem.name || !editingItem.expirationDate || editingItem.quantity <= 0 || editingItem.alarmDays <= 0) {
      setErrorMessage("Por favor, complete todos los campos de edición correctamente.");
      return;
    }
    setErrorMessage(null);
    const trimmedName = editingItem.name.trim();

    try {
      const itemDocRef = doc(db, 'artifacts', appId, 'users', userId, 'stock_items', editingItem.id);
      await updateDoc(itemDocRef, {
        name: trimmedName,
        quantity: editingItem.quantity,
        expirationDate: editingItem.expirationDate,
        alarmDays: editingItem.alarmDays, 
        category: editingItem.category, 
      });
      saveCommonName(trimmedName); // Asegura que el nombre editado se guarde como común (sanitizado el ID)
      setEditingItem(null); // Sale del modo edición
    } catch (error) {
      console.error("Error al actualizar artículo:", error);
      setErrorMessage("Error al actualizar el artículo.");
    }
  };

  // Eliminar un artículo
  const deleteItem = async (id) => {
    if (!db || !userId) return;
    try {
      const itemDocRef = doc(db, 'artifacts', appId, 'users', userId, 'stock_items', id);
      await deleteDoc(itemDocRef);
    } catch (error) {
      console.error("Error al eliminar artículo:", error);
      setErrorMessage("Error al eliminar el artículo.");
    }
  };

  // Determinar si hay artículos vencidos o en alarma (para el banner principal)
  const urgentItems = useMemo(() => {
    return items.filter(item => {
      // Pasa el umbral de alarma individual
      const status = checkExpirationStatus(item.expirationDate, item.alarmDays).status; 
      return status === 'Expired' || status === 'Warning';
    });
  }, [items, checkExpirationStatus]);

  // Muestra la modal de alarma si hay artículos urgentes.
  useEffect(() => {
    if (urgentItems.length > 0 && !loading) {
      setShowUrgentModal(true);
    }
  }, [urgentItems.length, loading]);
  
  // --- Funciones de la API de Gemini ---

  const generateGeminiContent = async (systemPrompt, userQuery) => {
    setGeminiLoading(true);
    setGeminiResponse(null);

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        tools: [{ "google_search": {} }], // Usar Google Search para grounding
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
    };

    let response = null;
    let delay = 1000;
    const maxRetries = 3;

    for (let i = 0; i < maxRetries; i++) {
        try {
            response = await fetch(GEMINI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                const result = await response.json();
                const text = result.candidates?.[0]?.content?.parts?.[0]?.text || "No se pudo generar una respuesta.";
                setGeminiResponse(text);
                break;
            } else if (response.status === 429 && i < maxRetries - 1) {
                // Throttle: Esperar y reintentar
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Backoff exponencial
            } else {
                const errorResult = await response.json();
                setGeminiResponse(`Error: ${errorResult.error?.message || response.statusText}`);
                break;
            }
        } catch (error) {
            if (i < maxRetries - 1) {
                // Error de red/fetch: Esperar y reintentar
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2;
            } else {
                setGeminiResponse("Error de conexión con el servicio de IA.");
            }
        }
    }
    
    setGeminiLoading(false);
    setShowGeminiModal(true);
  };
  
  // Función para generar sugerencia de uso para un solo artículo
  const generateUsageSuggestion = (item) => {
    const systemPrompt = `Actúa como un planificador de comidas y usos para el hogar. Proporciona una sugerencia de uso, receta o plan de consumo conciso (máximo 50 palabras) para el siguiente artículo, priorizando que sea consumido o usado pronto debido a su proximidad a la fecha de caducidad.`;
    const userQuery = `Artículo: "${item.name}" (Categoría: ${item.category}). Su estado actual es: ${checkExpirationStatus(item.expirationDate, item.alarmDays).message}. Dame una sugerencia de uso rápida.`;
    generateGeminiContent(systemPrompt, userQuery);
  };
  
  // Función para generar un plan de acción para todos los artículos urgentes
  const generateActionPlan = () => {
    if (urgentItems.length === 0) {
        setErrorMessage("No hay artículos vencidos o en alarma para generar un plan.");
        return;
    }
    
    const formattedList = urgentItems.map(item => 
        `[${checkExpirationStatus(item.expirationDate, item.alarmDays).status}] ${item.name} (${item.quantity} unidades, Vence en ${checkExpirationStatus(item.expirationDate, item.alarmDays).days} días)`
    ).join('\n');
    
    const systemPrompt = `Actúa como un gerente de inventario. Analiza la siguiente lista de artículos vencidos o en alarma y proporciona un resumen ejecutivo conciso (máximo 80 palabras) con un plan de acción priorizado para consumir o desechar el stock.`;
    const userQuery = `Analiza y prioriza el siguiente inventario urgente:\n\n${formattedList}`;
    generateGeminiContent(systemPrompt, userQuery);
  };


  // Función para obtener las clases de color Tailwind
  const getStatusClasses = (status) => {
    switch (status) {
      case 'Expired':
        return 'bg-red-500 text-white shadow-red-700/50';
      case 'Warning':
        return 'bg-amber-400 text-gray-900 shadow-amber-600/50';
      case 'OK':
      default:
        return 'bg-white text-gray-700 hover:bg-gray-50';
    }
  };

  if (loading && !isAuthReady) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100 p-4">
        <div className="text-xl font-semibold text-gray-600">Cargando aplicación y autenticando...</div>
      </div>
    );
  }

  // --- Componente de Formulario de Edición en Línea ---
  const EditForm = ({ item, handleEditChange, updateItem, setEditingItem }) => (
    <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 mt-2">
      <h4 className="text-md font-bold mb-3 text-gray-700">Editar Artículo: {item.name}</h4>
      <form onSubmit={updateItem} className="space-y-3">
        <div className="flex space-x-3">
            <input
                type="text"
                name="name"
                value={item.name}
                onChange={handleEditChange}
                placeholder="Nombre"
                required
                className="flex-1 px-3 py-1 border rounded-lg text-sm"
            />
            <input
                type="date"
                name="expirationDate"
                value={item.expirationDate}
                onChange={handleEditChange}
                required
                className="w-1/3 px-3 py-1 border rounded-lg text-sm"
            />
        </div>
        <div className="flex space-x-3 items-center">
            <label className="text-sm text-gray-600 min-w-max">Cantidad:</label>
            <input
                type="number"
                name="quantity"
                value={item.quantity}
                onChange={handleEditChange}
                min="1"
                required
                className="w-1/4 px-3 py-1 border rounded-lg text-sm"
            />
            <label className="text-sm text-gray-600 min-w-max">Alarma (días antes):</label>
            <input
                type="number"
                name="alarmDays"
                value={item.alarmDays}
                onChange={handleEditChange}
                min="1"
                required
                className="w-1/4 px-3 py-1 border rounded-lg text-sm"
            />
        </div>

        {/* Campo de Categoría para Edición */}
        <div>
            <label htmlFor="edit-category" className="block text-sm font-medium text-gray-700 mb-1">Categoría</label>
            <select
                id="edit-category"
                name="category"
                value={item.category}
                onChange={handleEditChange}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-emerald-500 focus:border-emerald-500 transition duration-150"
            >
                {CATEGORIES.map(cat => (
                    <option key={cat} value={cat}>{cat}</option>
                ))}
            </select>
        </div>
        
        <div className="flex justify-end space-x-2 pt-2">
          <button
            type="button"
            onClick={() => setEditingItem(null)}
            className="px-4 py-1 text-sm rounded-lg bg-gray-300 text-gray-800 hover:bg-gray-400 transition"
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="px-4 py-1 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition"
          >
            Guardar Cambios
          </button>
        </div>
      </form>
    </div>
  );
  
  // --- Componente Modal de Notificación de Alarma ---
  const NotificationModal = () => {
      const criticalItems = urgentItems.filter(item => checkExpirationStatus(item.expirationDate, item.alarmDays).status === 'Warning');
      const expiredItems = urgentItems.filter(item => checkExpirationStatus(item.expirationDate, item.alarmDays).status === 'Expired');
      
      const handleClose = () => {
          setShowUrgentModal(false);
      };

      return (
          <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4">
              <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 transform transition-all scale-100 animate-in fade-in zoom-in-50">
                  <h3 className="text-3xl font-extrabold text-red-600 mb-4 border-b pb-2 flex items-center">
                      <svg className="w-8 h-8 mr-2" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"></path></svg>
                      ¡ATENCIÓN! Vencimientos Próximos
                  </h3>
                  
                  {expiredItems.length > 0 && (
                      <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-3 mb-3 rounded">
                          <p className="font-bold">Artículos Vencidos ({expiredItems.length}):</p>
                          <ul className="list-disc ml-5 text-sm">
                              {expiredItems.map(item => <li key={item.id}>{item.name} (Vencido hace {Math.abs(checkExpirationStatus(item.expirationDate, item.alarmDays).days)} días)</li>)}
                          </ul>
                      </div>
                  )}

                  {criticalItems.length > 0 && (
                      <div className="bg-amber-100 border-l-4 border-amber-500 text-amber-700 p-3 mb-4 rounded">
                          <p className="font-bold">Artículos en Alarma ({criticalItems.length}):</p>
                          <ul className="list-disc ml-5 text-sm">
                              {criticalItems.map(item => <li key={item.id}>{item.name} (Vence en {checkExpirationStatus(item.expirationDate, item.alarmDays).days} días)</li>)}
                          </ul>
                      </div>
                  )}

                  <button
                      onClick={handleClose}
                      className="mt-4 w-full bg-red-600 text-white py-2 rounded-lg font-bold shadow-lg shadow-red-500/50 hover:bg-red-700 transition duration-200"
                  >
                      Entendido, cerrar aviso
                  </button>
              </div>
          </div>
      );
  };
  
  // --- Componente Modal de Importación ---
  const ImportModal = () => {
      
      const exampleData = `Leche
Queso
Refresco`;

      return (
          <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4">
              <div className="bg-white rounded-xl shadow-2xl max-w-xl w-full p-6 transform transition-all scale-100 animate-in fade-in zoom-in-50">
                  <h3 className="text-2xl font-extrabold text-emerald-600 mb-4 border-b pb-2 flex items-center">
                      <svg className="w-6 h-6 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                      Importar Nombres Comunes para Autocompletado
                  </h3>

                  <p className="text-sm text-gray-600 mb-3">
                      Pega una lista de nombres de artículos (uno por línea) para agregarlos al autocompletado. Esto no crea artículos de stock.
                      Puedes copiar una columna de nombres directamente desde Excel o Google Sheets.
                  </p>
                  
                  <div className="bg-gray-100 p-3 rounded-lg text-xs font-mono mb-4 text-gray-800 border">
                      <p className="font-bold mb-1 text-sm">Ejemplo de formato (solo la columna de nombres):</p>
                      <pre className="whitespace-pre-wrap">{exampleData}</pre>
                  </div>
                  
                  <textarea
                      rows="8"
                      value={importData}
                      onChange={(e) => setImportData(e.target.value)}
                      placeholder="Pega aquí tu lista de nombres..."
                      className="w-full p-3 border border-gray-300 rounded-lg focus:ring-emerald-500 focus:border-emerald-500"
                  ></textarea>

                  {loading && <p className="text-sm text-emerald-600 mt-2">Importando datos, por favor espera...</p>}

                  <div className="flex justify-end space-x-2 pt-4">
                    <button
                      type="button"
                      onClick={() => { setShowImportModal(false); setErrorMessage(null); }}
                      className="px-4 py-2 text-sm rounded-lg bg-gray-300 text-gray-800 hover:bg-gray-400 transition"
                      disabled={loading}
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={handleImport}
                      className="px-4 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition"
                      disabled={loading || !importData.trim()}
                    >
                      {loading ? 'Procesando...' : 'Importar Nombres'}
                    </button>
                  </div>
              </div>
          </div>
      );
  };
  
  // --- Componente Modal de Respuesta de Gemini ---
  const GeminiResponseModal = () => {
      
      const handleClose = () => {
          setGeminiResponse(null);
          setShowGeminiModal(false);
      };

      return (
          <div className="fixed inset-0 bg-black bg-opacity-70 z-50 flex justify-center items-center p-4">
              <div className="bg-white rounded-xl shadow-2xl max-w-xl w-full p-6 transform transition-all scale-100 animate-in fade-in zoom-in-50">
                  <h3 className="text-2xl font-extrabold text-indigo-600 mb-4 border-b pb-2 flex items-center">
                      <svg className="w-6 h-6 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.75 17L12 20.25 14.25 17m-4.5-4L12 16.25 14.25 13m-4.5-4L12 12.25 14.25 9m-4.5-4L12 8.25 14.25 5"></path></svg>
                      Asistente de Stock Gemini
                  </h3>
                  
                  {geminiLoading ? (
                      <div className="flex items-center space-x-2 justify-center py-8">
                          <svg className="animate-spin h-5 w-5 text-indigo-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                          <p className="text-indigo-500 font-medium">Generando sugerencia...</p>
                      </div>
                  ) : (
                    <div className="bg-gray-50 p-4 rounded-lg border">
                        <p className="whitespace-pre-wrap text-gray-700">{geminiResponse}</p>
                    </div>
                  )}

                  <button
                      onClick={handleClose}
                      className="mt-4 w-full bg-indigo-600 text-white py-2 rounded-lg font-bold shadow-lg shadow-indigo-500/50 hover:bg-indigo-700 transition duration-200"
                  >
                      Cerrar
                  </button>
              </div>
          </div>
      );
  };


  return (
    <div className="min-h-screen bg-gray-100 p-4 sm:p-8 font-['Inter']">
      <script src="https://cdn.tailwindcss.com"></script>
      
      {/* Modales */}
      {showUrgentModal && urgentItems.length > 0 && <NotificationModal />}
      {showImportModal && <ImportModal />}
      {showGeminiModal && <GeminiResponseModal />}

      <header className="text-center mb-8">
        <h1 className="text-4xl font-extrabold text-gray-800">
          <span className="text-emerald-600">Stock</span>Control: Vencimientos
        </h1>
        <p className="text-gray-500 mt-2">ID de Usuario: <span className="font-mono text-xs px-2 py-1 bg-gray-200 rounded">{userId || 'N/A'}</span></p>
      </header>

      {/* BANNER DE ALARMA/NOTIFICACIÓN (Se mantiene como respaldo visual) */}
      {urgentItems.length > 0 && (
        <div className="bg-red-600/90 text-white p-4 sm:p-6 rounded-xl shadow-2xl mb-8 border-4 border-red-800">
          <h2 className="text-2xl font-bold mb-2 flex items-center">
            <svg className="w-6 h-6 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.3 16c-.77 1.333.192 3 1.732 3z"></path></svg>
            ALARMA DE VENCIMIENTOS PENDIENTES
          </h2>
          <p className="font-medium">
            ¡Tienes {urgentItems.length} artículo(s) que están a punto de vencer o ya han expirado! (Ver detalle en ventana emergente)
          </p>
        </div>
      )}

      {errorMessage && (
        <div className={`border px-4 py-3 rounded relative mb-4 ${errorMessage.includes('Error') ? 'bg-red-100 border-red-400 text-red-700' : 'bg-emerald-100 border-emerald-400 text-emerald-700'}`} role="alert">
          <strong className="font-bold">{errorMessage.includes('Error') ? 'Error:' : 'Éxito:'}</strong>
          <span className="block sm:inline ml-2">{errorMessage}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        
        {/* Columna de Formulario (Izquierda) */}
        <div className="lg:col-span-1 bg-white p-6 rounded-xl shadow-lg h-fit sticky top-4">
          <h2 className="text-2xl font-semibold text-gray-700 mb-4 border-b pb-2">Añadir Nuevo Artículo</h2>
          <form onSubmit={addItem} className="space-y-4">
            
            {/* CAMPO DE NOMBRE CON DATALIST (AUTOCOMPLETADO) */}
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">Nombre del Artículo</label>
              <input
                type="text"
                id="name"
                name="name"
                list="article-names" // Conecta el input con la datalist
                value={newItem.name}
                onChange={handleInputChange}
                placeholder="Escribe o selecciona un artículo"
                required
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-emerald-500 focus:border-emerald-500 transition duration-150"
              />
              
              {/* Datalist: Muestra las sugerencias de nombres únicos */}
              <datalist id="article-names">
                {uniqueItemNames.map(name => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            {/* FIN CAMPO DE NOMBRE CON DATALIST */}

            <div>
              <label htmlFor="expirationDate" className="block text-sm font-medium text-gray-700 mb-1">Fecha de Vencimiento</label>
              <input
                type="date"
                id="expirationDate"
                name="expirationDate"
                value={newItem.expirationDate}
                onChange={handleInputChange}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-emerald-500 focus:border-emerald-500 transition duration-150"
              />
            </div>
            
            {/* Campo de Categoría para Creación */}
            <div>
              <label htmlFor="category" className="block text-sm font-medium text-gray-700 mb-1">Categoría</label>
              <select
                id="category"
                name="category"
                value={newItem.category}
                onChange={handleInputChange}
                required
                className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-emerald-500 focus:border-emerald-500 transition duration-150"
              >
                  {CATEGORIES.map(cat => (
                      <option key={cat} value={cat}>{cat}</option>
                  ))}
              </select>
            </div>

            <div className='flex space-x-4'>
                <div className='flex-1'>
                    <label htmlFor="quantity" className="block text-sm font-medium text-gray-700 mb-1">Cantidad</label>
                    <input
                      type="number"
                      id="quantity"
                      name="quantity"
                      value={newItem.quantity}
                      onChange={handleInputChange}
                      min="1"
                      required
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-emerald-500 focus:border-emerald-500 transition duration-150"
                    />
                </div>
                <div className='flex-1'>
                    <label htmlFor="alarmDays" className="block text-sm font-medium text-gray-700 mb-1">Alarma (días antes)</label>
                    <input
                      type="number"
                      id="alarmDays"
                      name="alarmDays"
                      value={newItem.alarmDays}
                      onChange={handleInputChange}
                      min="1"
                      required
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-emerald-500 focus:border-emerald-500 transition duration-150"
                    />
                </div>
            </div>
            
            <button
              type="submit"
              className="w-full bg-emerald-600 text-white py-3 rounded-lg font-bold shadow-lg shadow-emerald-500/50 hover:bg-emerald-700 transition duration-200 transform hover:scale-[1.01]"
              disabled={loading || !userId}
            >
              {loading ? 'Guardando...' : 'Guardar Artículo'}
            </button>
            
            <button
                type="button"
                onClick={() => { setShowImportModal(true); setErrorMessage(null); }}
                className="w-full bg-indigo-500 text-white py-2 rounded-lg font-medium hover:bg-indigo-600 transition duration-200 mt-2 flex items-center justify-center space-x-2"
                disabled={loading || !userId}
            >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                <span>Importar Nombres Comunes</span>
            </button>

            <p className="text-xs text-gray-400 text-center mt-2">Los datos se guardan en tu espacio personal de Firebase.</p>
          </form>
        </div>

        {/* Columna de Lista de Artículos (Derecha) */}
        <div className="lg:col-span-2">
          <h2 className="text-2xl font-semibold text-gray-700 mb-4 border-b pb-2 flex justify-between items-center">
            Artículos en Stock ({items.length})
            
            {/* Botón Global de Plan de Acción */}
            {urgentItems.length > 0 && (
                <button
                    onClick={generateActionPlan}
                    disabled={geminiLoading}
                    className="ml-4 px-3 py-1 text-sm rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 transition duration-200 disabled:opacity-50"
                >
                    {geminiLoading ? 'Generando...' : '✨ Generar Plan de Acción'}
                </button>
            )}
          </h2>
          
          {loading && (
            <div className="text-center py-8 text-gray-500">
              Cargando lista de artículos...
            </div>
          )}

          {!loading && items.length === 0 && (
            <div className="text-center py-12 bg-white rounded-xl shadow-md text-gray-500 border-2 border-dashed border-gray-300">
              <p className="text-lg font-medium">No hay artículos en el inventario.</p>
              <p className="text-sm mt-1">Usa el formulario de la izquierda para empezar a agregar.</p>
            </div>
          )}

          <div className="space-y-4">
            {items.map(item => {
              // Usa el umbral de alarma individual del artículo
              const { status, days, message } = checkExpirationStatus(item.expirationDate, item.alarmDays);
              const statusClasses = getStatusClasses(status);
              const isEditing = editingItem && editingItem.id === item.id;

              return (
                <div key={item.id} className={`p-4 rounded-xl shadow-lg transition duration-300 ${statusClasses}`}>
                  
                  {isEditing ? (
                    // Mostrar el formulario de edición si está en modo edición
                    <EditForm
                        item={editingItem}
                        handleEditChange={handleEditChange}
                        updateItem={updateItem}
                        setEditingItem={setEditingItem}
                    />
                  ) : (
                    // Mostrar la vista normal del artículo
                    <div className="flex justify-between items-start">
                        <div className="flex-1 min-w-0 pr-4">
                          <p className={`text-lg font-bold truncate ${status === 'Expired' ? 'line-through' : ''}`}>
                            {item.name}
                          </p>
                          <div className='flex items-center space-x-4 text-sm mt-1'>
                            <div>
                                <span className="font-semibold mr-2">Cantidad:</span> {item.quantity}
                            </div>
                            {/* Mostrar la categoría */}
                            <div className='px-2 py-0.5 bg-gray-200 rounded-full text-xs font-medium text-gray-700'>
                                {item.category}
                            </div>
                          </div>
                          <div className="text-sm mt-1">
                            <span className="font-semibold mr-2">Vence:</span> {new Date(item.expirationDate).toLocaleDateString('es-ES')}
                          </div>
                          {/* Indicador de Estado/Alarma */}
                          <p className={`text-xs font-semibold mt-2 px-2 py-0.5 rounded-full w-fit ${status === 'Expired' ? 'bg-red-700 text-white' : status === 'Warning' ? 'bg-amber-600 text-gray-900' : 'bg-emerald-100 text-emerald-800'}`}>
                            {message}
                          </p>
                        </div>
                        
                        <div className='flex flex-col space-y-2'>
                            {/* Botón Gemini Suggestion */}
                            <button
                                onClick={() => generateUsageSuggestion(item)}
                                disabled={geminiLoading}
                                className={`px-2 py-1 text-xs rounded-full font-semibold transition duration-150 ${status === 'OK' ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200' : 'bg-white/90 text-indigo-700 hover:bg-white'}`}
                                aria-label="Sugerencia de uso con Gemini"
                            >
                                ✨ Receta/Uso
                            </button>

                            {/* Botones de Acción */}
                            <div className='flex space-x-1 justify-end'>
                                {/* Botón de Editar */}
                                <button
                                  onClick={() => setEditingItem(item)}
                                  className={`p-2 rounded-full transition duration-150 transform hover:scale-110 ${status === 'OK' ? 'text-gray-500 hover:bg-gray-100' : 'text-white hover:bg-white/30'}`}
                                  aria-label="Editar artículo"
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                                </button>

                                {/* Botón de Eliminar */}
                                <button
                                  onClick={() => deleteItem(item.id)}
                                  className={`p-2 rounded-full transition duration-150 transform hover:scale-110 ${status === 'OK' ? 'text-red-500 hover:bg-red-100' : 'text-white hover:bg-white/30'}`}
                                  aria-label="Eliminar artículo"
                                >
                                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                </button>
                            </div>
                        </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;