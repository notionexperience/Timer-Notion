import { supabase } from './supabase-init.js';

let currentUser = null; // null if guest, user object if logged in
const LOCAL_STORAGE_KEY_TASKS = 'focusflow_guest_tasks';
const LOCAL_STORAGE_KEY_NOTES = 'focusflow_guest_notes';

// --- Local Storage Functions for Guest Mode ---
function getGuestTasks() {
    try {
        const tasks = localStorage.getItem(LOCAL_STORAGE_KEY_TASKS);
        return tasks ? JSON.parse(tasks) : [];
    } catch (e) {
        console.error("Error parsing guest tasks from localStorage:", e);
        return [];
    }
}

function saveGuestTasks(tasks) {
    localStorage.setItem(LOCAL_STORAGE_KEY_TASKS, JSON.stringify(tasks));
}

function getGuestNote() {
    return localStorage.getItem(LOCAL_STORAGE_KEY_NOTES) || '';
}

function saveGuestNote(content) {
    localStorage.setItem(LOCAL_STORAGE_KEY_NOTES, content);
}

async function migrateGuestDataToSupabase() {
    if (!currentUser) {
        console.warn("No user to migrate guest data to.");
        return;
    }

    const guestTasks = getGuestTasks();
    const guestNote = getGuestNote();

    if (guestTasks.length > 0) {
        console.log("Migrating guest tasks to Supabase...");
        const tasksToInsert = guestTasks.map(task => ({
            user_id: currentUser.id,
            content: task.content,
            is_done: task.is_done,
            category: task.category,
            priority: task.priority,
            elapsed: task.elapsed,
            due_date: task.due_date || null, // Use due_date for consistency
            position: task.position || 0, // Include position
        }));

        const { error: tasksError } = await supabase.from("tasks").insert(tasksToInsert, { ignoreDuplicates: true });
        if (tasksError) {
            console.error("Error migrating guest tasks:", tasksError.message);
        } else {
            console.log("Guest tasks migrated successfully.");
            localStorage.removeItem(LOCAL_STORAGE_KEY_TASKS); // Clear local guest data after successful migration
        }
    }

    if (guestNote.length > 0) {
        console.log("Migrating guest note to Supabase...");
        const { error: noteError } = await supabase.from("notes").upsert(
            { user_id: currentUser.id, content: guestNote, updated_at: new Date().toISOString() },
            { onConflict: 'user_id' }
        );
        if (noteError) {
            console.error("Error migrating guest note:", noteError.message);
        } else {
            console.log("Guest note migrated successfully.");
            localStorage.removeItem(LOCAL_STORAGE_KEY_NOTES); // Clear local guest data
        }
    }
}


// --- Supabase Interaction Functions ---

async function signInUser(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("Login failed:", error.message);
    showCustomAlert("Login failed: " + error.message); // Replaced alert
  } else {
    console.log("Logged in:", data);
    await migrateGuestDataToSupabase();
    await checkUserAndLoadApp();
  }
}

async function signUpUser(email, password) {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) {
    console.error("Signup failed:", error.message);
    showCustomAlert("Signup failed: " + error.message); // Replaced alert
  } else {
    showCustomAlert("Signup successful – check your email to confirm"); // Replaced alert
    await migrateGuestDataToSupabase();
    await checkUserAndLoadApp();
  }
}

async function signOutUser() {
  await supabase.auth.signOut();
  currentUser = null;
  location.reload();
}

async function resetPasswordForEmailUser(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + "/reset.html"
  });

  if (error) {
    showCustomAlert("Error sending password setup email: " + error.message); // Replaced alert
  } else {
    showCustomAlert("Check your inbox to set your password."); // Replaced alert
  }
}


async function checkUserAndLoadApp() {
  const { data: { user } = {} } = await supabase.auth.getUser();

  const authSection = document.getElementById("auth-section");
  const appSection = document.getElementById("app-section");
  const guestModeMessage = document.getElementById("guestModeMessage");

  const authNavItems = document.getElementById("auth-nav-items");
  const userNavItems = document.getElementById("user-nav-items");
  const userEmailDisplay = document.getElementById("userEmailDisplay");

  if (user) {
    currentUser = user;
    if (authSection) authSection.style.display = "none";
    if (appSection) appSection.style.display = "block";
    if (guestModeMessage) guestModeMessage.style.display = "none";

    if (authNavItems) authNavItems.style.display = "none";
    if (userNavItems) userNavItems.style.display = "flex";
    if (userEmailDisplay) userEmailDisplay.textContent = `Logged in as: ${user.email}`;

  } else {
    currentUser = null;

    if (authNavItems) authNavItems.style.display = "flex";
    if (userNavItems) userNavItems.style.display = "none";
    if (authSection) authSection.style.display = "block";
    if (appSection) appSection.style.display = "block";

    const hasGuestData = getGuestTasks().length > 0 || getGuestNote().length > 0;
    if (guestModeMessage) {
        guestModeMessage.style.display = hasGuestData ? "block" : "none";
    }
    if (userEmailDisplay) userEmailDisplay.textContent = "Guest Mode";
  }
  await loadTasks();
  await loadNote();
}

// --- Data Persistence Functions (Conditional Logic) ---

async function loadTasks() {
    const taskList = document.getElementById("taskList");
    if (!taskList) { console.error("Task list element not found!"); return; }

    let tasks = [];
    if (currentUser) {
        const { data: supabaseTasks, error } = await supabase
            .from("tasks")
            .select("*")
            .eq("user_id", currentUser.id)
            .order("position", { ascending: true }) // Order by position for drag & drop
            .order("created_at", { ascending: false }); // Fallback order

        if (error) {
            console.error("Failed to load tasks from Supabase:", error.message);
            return;
        }
        tasks = supabaseTasks;
        console.log("Loaded tasks from Supabase:", tasks);
    } else {
        tasks = getGuestTasks();
        // Ensure guest tasks are also sorted by position if available, otherwise by creation
        tasks.sort((a, b) => (a.position || 0) - (b.position || 0) || (new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
        console.log("Loaded tasks from Local Storage (Guest Mode):", tasks);
    }
    renderTasks(tasks);
    updateTaskCounter();
}

async function addTask(content, category = "Personal", priority = "Medium", dueDate = null) {
    let newTask = null;
    const taskList = document.getElementById("taskList");
    // Determine the highest current position to add the new task at the end
    const lastTaskPosition = taskList.children.length > 0 ?
        parseInt(taskList.children[taskList.children.length - 1].dataset.position) + 1 : 0;

    if (currentUser) {
        const { data, error } = await supabase.from("tasks").insert([
            {
                user_id: currentUser.id,
                content: content,
                is_done: false,
                category: category,
                priority: priority,
                elapsed: 0,
                due_date: dueDate, // Save the due date
                position: lastTaskPosition, // Set initial position
            },
        ]).select();

        if (error) {
            console.error("Add task to Supabase failed:", error.message);
            return null;
        }
        newTask = data[0];
    } else {
        const guestTasks = getGuestTasks();
        newTask = {
            id: Date.now(),
            content: content,
            is_done: false,
            category: category,
            priority: priority,
            elapsed: 0,
            created_at: new Date().toISOString(),
            due_date: dueDate, // Save the due date (consistent naming)
            position: lastTaskPosition, // Set initial position
        };
        guestTasks.push(newTask);
        saveGuestTasks(guestTasks);
        console.log("Added task to Local Storage (Guest Mode):", newTask);
    }
    return newTask;
}

async function deleteTask(id) {
    if (currentUser) {
        const { error } = await supabase
            .from("tasks")
            .delete()
            .eq("id", id)
            .eq("user_id", currentUser.id);

        if (error) console.error("Failed to delete task from Supabase:", error.message);
    } else {
        let guestTasks = getGuestTasks();
        guestTasks = guestTasks.filter(task => task.id !== Number(id));
        saveGuestTasks(guestTasks);
        console.log("Deleted task from Local Storage (Guest Mode):", id);
    }
    await updateTaskPositionsInDB(); // Re-save positions after deletion
}

async function saveNote(content) {
    if (currentUser) {
        const { error } = await supabase.from("notes").upsert([
            {
                user_id: currentUser.id,
                content: content,
                updated_at: new Date().toISOString(),
            },
        ], { onConflict: 'user_id' });

        if (error) console.error("Failed to save note to Supabase:", error.message);
    } else {
        saveGuestNote(content);
        console.log("Saved note to Local Storage (Guest Mode).");
    }
}

async function loadNote() {
    const notesArea = document.getElementById("notes");
    if (!notesArea) { console.error("Notes area element not found!"); return; }

    let noteContent = '';
    if (currentUser) {
        const { data, error } = await supabase
            .from("notes")
            .select("content")
            .eq("user_id", currentUser.id)
            .single();

        if (error && error.code !== 'PGRST116') {
            console.error("Failed to load note from Supabase:", error.message);
            return;
        }
        noteContent = data?.content || '';
        console.log("Loaded note from Supabase:", noteContent);
    } else {
        noteContent = getGuestNote();
        console.log("Loaded note from Local Storage (Guest Mode):", noteContent);
    }
    notesArea.value = noteContent;
}

// --- Helper / UI Functions ---

function renderTasks(tasks) {
  const taskList = document.getElementById("taskList");
  if (!taskList) {
    console.error("Task list element not found!");
    return;
  }
  taskList.innerHTML = "";
  tasks.forEach(task => {
    const li = createTaskElement(task);
    taskList.appendChild(li);
  });
}

// Function to update task positions in the database/local storage
async function updateTaskPositionsInDB() {
    const taskList = document.getElementById("taskList");
    if (!taskList) return;

    const tasksInOrder = Array.from(taskList.children).map((li, index) => {
        return {
            id: Number(li.dataset.taskId),
            position: index,
        };
    });

if (currentUser) {
    // Use individual update calls instead of upsert to avoid ON CONFLICT issue
    for (const task of tasksInOrder) {
        const { error } = await supabase
            .from("tasks")
            .update({ position: task.position })
            .eq("id", task.id)
            .eq("user_id", currentUser.id); // Ensure RLS is respected
        if (error) {
            console.error(`Failed to update position for task ${task.id} in Supabase:`, error.message);
        }
    }
        console.log("Task positions updated in Supabase.");
    } else {
        // Update positions in Local Storage
        let guestTasks = getGuestTasks();
        tasksInOrder.forEach(updatedTask => {
            const taskIndex = guestTasks.findIndex(t => t.id === updatedTask.id);
            if (taskIndex !== -1) {
                guestTasks[taskIndex].position = updatedTask.position;
            }
        });
        saveGuestTasks(guestTasks);
        console.log("Task positions updated in Local Storage (Guest Mode).");
    }
}


function updateTaskCounter() {
  const taskList = document.getElementById("taskList");
  if (!taskList) return;
  const totalTasks = taskList.children.length;
  const finishedTasks = taskList.querySelectorAll("li.finished").length;

  const counterSpan = document.querySelector("#taskCountToday .count");

  if (counterSpan) {
    counterSpan.textContent = `${finishedTasks} / ${totalTasks}`;
  }
}
// Theme Toggling
const themeToggleBtn = document.getElementById("themeToggle");
const storedTheme = localStorage.getItem("theme");

// Apply stored theme on load
if (storedTheme) {
    document.body.setAttribute("data-theme", storedTheme);
    if (themeToggleBtn) {
        themeToggleBtn.setAttribute("aria-pressed", storedTheme === "dark");
    }
}

if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
        const currentTheme = document.body.getAttribute("data-theme");
        const newTheme = currentTheme === "dark" ? "light" : "dark";
        document.body.setAttribute("data-theme", newTheme);
        localStorage.setItem("theme", newTheme);
        themeToggleBtn.setAttribute("aria-pressed", newTheme === "dark");
    });
}

// Timer variables and functions
let time = 0;
let timerInterval;
const timerElement = document.getElementById("timer");
const timeInput = document.getElementById("timeInput");
const setButton = document.getElementById("setButton");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");

// NEW: Get the audio element for timer end sound
const timerEndSound = document.getElementById('timerEndSound');

// NEW: Function to request notification permission
function requestNotificationPermission() {
    if ("Notification" in window) { // Check if Notification API is supported by the browser
        Notification.requestPermission().then(permission => {
            if (permission === "granted") {
                console.log("Notification permission granted.");
            } else if (permission === "denied") {
                console.warn("Notification permission denied. Please enable notifications for this site in your browser settings if you want them.");
            }
            // 'default' means user closed prompt without choosing, no action needed immediately
        });
    } else {
        console.warn("Browser does not support desktop notifications.");
    }
}

// NEW: Function to handle actions when the main timer finishes
function timerFinished() {
    // Play sound
    if (timerEndSound) {
        timerEndSound.play().catch(e => console.error("Error playing sound:", e));
    }

    // Show browser notification
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification("FocusFlow Timer", {
            body: "Your main timer has finished!",
            icon: "./assets/logo.png" // Optional: Path to a small icon for the notification
                                         // Make sure this path is correct, or remove 'icon' if you don't have one.
        });
    } else {
        // Fallback for browsers without notification support or if permission denied
        showCustomAlert("Time's up!"); // Using your custom alert
    }

    // Reset timer display and buttons (existing logic)
    if(timerElement) timerElement.textContent = "Time's up!";
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
}


function updateTimerDisplay() {
  const minutes = Math.floor(time / 60);
  const seconds = time % 60;
  if(timerElement) timerElement.textContent = `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;

  const totalInput = parseInt(timeInput.value);
  const totalTime = isNaN(totalInput) || totalInput <= 0 ? 1 : totalInput * 60;

  const percent = Math.max(0, Math.min(100, (time / totalTime) * 100));
  const timerBar = document.getElementById("timerBar");
  if (timerBar) timerBar.style.width = percent + "%";
}

function setTimer() {
  const minutes = parseInt(timeInput.value);
  if (!isNaN(minutes) && minutes > 0) {
    time = minutes * 60;
    updateTimerDisplay();
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
    clearInterval(timerInterval);
  }
}

function updateTimer() {
  if (time <= 0) {
    clearInterval(timerInterval);
    timerFinished(); // MODIFIED: Call the new function here
    return;
  }
  updateTimerDisplay();
  time--;
}

function startTimer() {
  if (startButton) startButton.disabled = true;
  if (stopButton) stopButton.disabled = false;
  if(timerElement) timerElement.classList.add("active");
  timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
  if (startButton) startButton.disabled = false;
  if (stopButton) stopButton.disabled = true;
  if(timerElement) timerElement.classList.remove("active");
  clearInterval(timerInterval);
}

// Task timer logic
let activeTaskTimer = null;
let activeTaskId = null; // Store the LI element or its task.id for active timing

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function stopTaskTimerIfRunning(liToExclude) {
    // If there's an active timer for a *different* task, stop it.
    if (activeTaskTimer && activeTaskId && activeTaskId.dataset.taskId !== liToExclude.dataset.taskId) {
        clearInterval(activeTaskTimer);
        const previousActiveLi = document.querySelector(`[data-task-id="${activeTaskId.dataset.taskId}"]`);
        if (previousActiveLi) {
            previousActiveLi.classList.remove("active-task");
            const buttons = previousActiveLi.querySelectorAll(".timer-button");
            if (buttons[0]) buttons[0].disabled = false; // start
            if (buttons[1]) buttons[1].disabled = true;  // stop
        }
        activeTaskTimer = null;
        activeTaskId = null;
    }
}

async function startTaskTimer(li) { // Made async to save elapsed time
    if (li.classList.contains("finished")) return;
    if (activeTaskTimer && activeTaskId && activeTaskId.dataset.taskId === li.dataset.taskId) return; // Already timing this task

    stopTaskTimerIfRunning(li); // Stop any *other* active timer

    li.classList.add("active-task");
    const timerDisplay = li.querySelector(".task-timer");
    const startBtn = li.querySelector(".timer-button:not(.stop)");
    const stopBtn = li.querySelector(".timer-button.stop");

    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;

    activeTaskId = li; // Store the LI element for the active task

    activeTaskTimer = setInterval(async () => {
        let elapsed = parseInt(li.dataset.elapsed, 10) || 0;
        elapsed++;
        li.dataset.elapsed = elapsed;
        if(timerDisplay) timerDisplay.textContent = formatTime(elapsed);

        // Save elapsed time to Supabase or LocalStorage periodically
        const taskId = li.dataset.taskId;
        if (taskId && elapsed % 5 === 0) { // Save every 5 seconds
            if (currentUser) {
                const { error } = await supabase
                    .from("tasks")
                    .update({ elapsed: elapsed })
                    .eq("id", taskId)
                    .eq("user_id", currentUser.id);
                if (error) console.error("Failed to update elapsed time in Supabase:", error.message);
            } else {
                // Update guest task in localStorage
                let guestTasks = getGuestTasks();
                const taskIndex = guestTasks.findIndex(t => t.id == Number(taskId));
                if (taskIndex !== -1) {
                    guestTasks[taskIndex].elapsed = elapsed;
                    saveGuestTasks(guestTasks);
                }
            }
        }
    }, 1000);
}

async function stopTaskTimer(li) { // Made async for saving
    if (activeTaskId && activeTaskId.dataset.taskId !== li.dataset.taskId) return; // Not the currently active timer
    clearInterval(activeTaskTimer);
    activeTaskTimer = null;
    activeTaskId = null;

    li.classList.remove("active-task");

    const startBtn = li.querySelector(".timer-button:not(.stop)");
    const stopBtn = li.querySelector(".timer-button.stop");

    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;

    // Save final elapsed time
    const taskId = li.dataset.taskId;
    const finalElapsed = parseInt(li.dataset.elapsed, 10) || 0;
    if (taskId) {
        if (currentUser) {
            const { error } = await supabase
                .from("tasks")
                .update({ elapsed: finalElapsed })
                .eq("id", taskId)
                .eq("user_id", currentUser.id);
            if (error) console.error("Failed to save final elapsed time in Supabase:", error.message);
        } else {
            // Update guest task in localStorage
            let guestTasks = getGuestTasks();
            const taskIndex = guestTasks.findIndex(t => t.id == Number(taskId));
            if (taskIndex !== -1) {
                guestTasks[taskIndex].elapsed = finalElapsed;
                saveGuestTasks(guestTasks);
            }
        }
    }
}

// Helper to get today's date in YYYY-MM-DD format
function getTodayDateString() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function createTaskElement(task) {
    const li = document.createElement("li");
    li.draggable = true;

    li.dataset.category = task.category || "";
    li.dataset.elapsed = task.elapsed || 0;
    li.dataset.taskId = task.id;
    li.dataset.priority = task.priority || "Medium";
    li.dataset.position = task.position || 0; // Store position

    // Apply date-related classes
    const taskDueDate = task.due_date; // Use task.due_date directly
    if (taskDueDate) {
        const todayDateString = getTodayDateString();
        if (taskDueDate === todayDateString) {
            li.classList.add('task-due-today');
        } else if (taskDueDate < todayDateString) {
            li.classList.add('task-overdue');
        }
    }

    // Checkbox
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.is_done || false;

    checkbox.addEventListener("change", async () => {
      if (checkbox.checked) {
        li.classList.add("finished");
        const finishedTasks = [...taskList.children].filter(item => item.classList.contains("finished"));
        const lastFinished = finishedTasks[finishedTasks.length - 1];
        if (lastFinished) {
          taskList.insertBefore(li, lastFinished.nextSibling);
        } else {
          taskList.appendChild(li);
        }
        stopTaskTimer(li);
      } else {
        li.classList.remove("finished");
        const firstUnfinished = [...taskList.children].find(item => !item.classList.contains("finished"));
        if (firstUnfinished) {
          taskList.insertBefore(li, firstUnfinished);
        } else {
          taskList.prepend(li);
        }
      }

      const taskId = li.dataset.taskId;
      if (taskId) {
        if (currentUser) {
            const { error } = await supabase
              .from("tasks")
              .update({ is_done: checkbox.checked })
              .eq("id", taskId)
              .eq("user_id", currentUser.id);
            if (error) console.error("Update error (Supabase):", error.message);
        } else {
            let guestTasks = getGuestTasks();
            const taskIndex = guestTasks.findIndex(t => t.id == Number(taskId));
            if (taskIndex !== -1) {
                guestTasks[taskIndex].is_done = checkbox.checked;
                saveGuestTasks(guestTasks);
            }
        }
      }
      await updateTaskPositionsInDB(); // Update positions after checkbox change
      updateTaskCounter();
    });

    if (checkbox.checked) {
      li.classList.add("finished");
    }

    // Task text span (marked.js usage)
    const span = document.createElement("span");
    span.classList.add("task-text");
    span.innerHTML = marked.parse(task.content || "");
    span.setAttribute("data-raw", task.content || "");

    // Due Date Display
    const dueDateDisplay = document.createElement("span");
    dueDateDisplay.classList.add("due-date-display");
    dueDateDisplay.style.cursor = "pointer";
    dueDateDisplay.title = "Click to set/change due date";

    // Due Date Input
    const dueDateInput = document.createElement("input");
    dueDateInput.type = "date";
    dueDateInput.classList.add("date-input");
    dueDateInput.value = task.due_date || ''; // Initialize with task's due_date
    dueDateInput.style.display = 'none'; // Initially hidden

    function updateDueDateDisplayAndClasses() {
        if (task.due_date) {
            const date = new Date(task.due_date);
            const today = new Date();
            today.setHours(0, 0, 0, 0); // Normalize to start of day

            const taskDate = new Date(date);
            taskDate.setHours(0, 0, 0, 0); // Normalize to start of day

            const diffTime = taskDate.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            dueDateDisplay.textContent = `📅 ${date.toLocaleDateString()}`;
            li.classList.remove("task-due-today", "task-overdue"); // Remove existing classes

            if (diffDays === 0) {
                li.classList.add("task-due-today");
            } else if (diffDays < 0) {
                li.classList.add("task-overdue");
            }
        } else {
            dueDateDisplay.textContent = "📅 No due date";
            li.classList.remove("task-due-today", "task-overdue");
        }
    }

    dueDateDisplay.addEventListener("click", () => {
        dueDateDisplay.style.display = 'none';
        dueDateInput.style.display = 'inline-block'; // Show input
        dueDateInput.focus();
    });

    dueDateInput.addEventListener("change", async () => {
        const newDueDate = dueDateInput.value; // YYYY-MM-DD string
        task.due_date = newDueDate || null; // Update task object

        // Update Supabase/LocalStorage
        if (currentUser) {
            const { error } = await supabase
                .from("tasks")
                .update({ due_date: task.due_date })
                .eq("id", task.id)
                .eq("user_id", currentUser.id);
            if (error) console.error("Failed to update due date (Supabase):", error.message);
        } else {
            let guestTasks = getGuestTasks();
            const taskIndex = guestTasks.findIndex(t => t.id == task.id);
            if (taskIndex !== -1) {
                guestTasks[taskIndex].due_date = task.due_date; // Save to guest property
                saveGuestTasks(guestTasks);
            }
        }
        updateDueDateDisplayAndClasses(); // Update display and classes immediately
    });

    dueDateInput.addEventListener("blur", () => {
        dueDateInput.style.display = 'none';
        dueDateDisplay.style.display = 'inline-block'; // Show display
        updateDueDateDisplayAndClasses(); // Ensure display is updated when blurring input
    });

    updateDueDateDisplayAndClasses(); // Initial call to set display and classes


    // Category label
    const categoryLabel = document.createElement("span");
    categoryLabel.classList.add("category-label");
    categoryLabel.textContent = `🏷️ ${task.category || "Personal"}`;
    categoryLabel.dataset.category = task.category || "";
    categoryLabel.style.cursor = "pointer";
    categoryLabel.title = `Filter by ${task.category || "Personal"}`;

    categoryLabel.addEventListener("click", async (e) => {
      if (e.ctrlKey || e.metaKey || e.button === 2) {
        e.preventDefault();
        const select = document.createElement("select");
        ["Work", "Personal", "Health"].forEach(optionText => {
          const option = document.createElement("option");
          option.value = optionText;
          option.textContent = optionText;
          if (optionText === task.category) option.selected = true;
          select.appendChild(option);
        });

        async function saveCategory() {
          const newCategory = select.value;
          task.category = newCategory;
          categoryLabel.textContent = `🏷️ ${newCategory}`;
          categoryLabel.dataset.category = newCategory;
          li.dataset.category = newCategory;
          select.replaceWith(categoryLabel);

          // Update Supabase/LocalStorage
          if (currentUser) {
              const { error } = await supabase
                .from("tasks")
                .update({ category: newCategory })
                .eq("id", task.id)
                .eq("user_id", currentUser.id);
              if (error) console.error("Failed to update category (Supabase):", error.message);
          } else {
              let guestTasks = getGuestTasks();
              const taskIndex = guestTasks.findIndex(t => t.id == task.id);
              if (taskIndex !== -1) {
                  guestTasks[taskIndex].category = newCategory;
                  saveGuestTasks(guestTasks);
              }
          }
        }

        select.addEventListener("blur", saveCategory);
        select.addEventListener("keydown", e => {
          if (e.key === "Enter") {
            e.preventDefault();
            saveCategory();
          }
        });

        categoryLabel.replaceWith(select);
        select.focus();
      } else {
        const allTasks = document.querySelectorAll("#taskList li");
        const isActive = categoryLabel.classList.toggle("active-category");

        allTasks.forEach(taskEl => {
          const taskCat = taskEl.dataset.category;
          const shouldShow = isActive ? taskCat === task.category : true;
          taskEl.style.display = shouldShow ? "" : "none";
        });

        document.querySelectorAll(".category-label").forEach(label => {
          if (label !== categoryLabel) label.classList.remove("active-category");
        });

        if (!isActive) {
          allTasks.forEach(taskEl => taskEl.style.display = "");
        }
      }
    });

    // Priority label
    const priorityLabel = document.createElement("span");
    priorityLabel.classList.add("priority-label");
    priorityLabel.textContent = `⚡ ${task.priority || "Medium"}`;
    priorityLabel.style.cursor = "pointer";
    priorityLabel.title = `Filter by priority: ${task.priority || "Medium"}`;

    priorityLabel.addEventListener("click", async (e) => {
      if (e.ctrlKey || e.metaKey || e.button === 2) {
        e.preventDefault();

        const select = document.createElement("select");
        ["Low", "Medium", "High"].forEach(optionText => {
          const option = document.createElement("option");
          option.value = optionText;
          option.textContent = optionText;
          if (optionText === task.priority) option.selected = true;
          select.appendChild(option);
        });

        async function savePriority() {
          const newPriority = select.value;
          task.priority = newPriority;

          priorityLabel.textContent = `⚡ ${newPriority}`;
          priorityLabel.title = `Filter by priority: ${newPriority}`;
          li.dataset.priority = newPriority;

          select.replaceWith(priorityLabel);

          // Update Supabase/LocalStorage
          if (currentUser) {
              const { error } = await supabase
                .from("tasks")
                .update({ priority: newPriority })
                .eq("id", task.id)
                .eq("user_id", currentUser.id);
              if (error) console.error("Failed to update priority (Supabase):", error.message);
          } else {
              let guestTasks = getGuestTasks();
              const taskIndex = guestTasks.findIndex(t => t.id == task.id);
              if (taskIndex !== -1) {
                  guestTasks[taskIndex].priority = newPriority;
                  saveGuestTasks(guestTasks);
              }
          }
        }

        select.addEventListener("blur", savePriority);
        select.addEventListener("keydown", e => {
          if (e.key === "Enter") {
            e.preventDefault();
            savePriority();
          }
        });

        priorityLabel.replaceWith(select);
        select.focus();
      } else {
        const allTasks = document.querySelectorAll("#taskList li");
        const isActive = priorityLabel.classList.toggle("active-priority");

        allTasks.forEach(taskEl => {
          const taskPriority = taskEl.dataset.priority;
          const shouldShow = isActive ? taskPriority === (task.priority || "Medium") : true;
          taskEl.style.display = shouldShow ? "" : "none";
        });

        document.querySelectorAll(".priority-label").forEach(label => {
          if (label !== priorityLabel) label.classList.remove("active-priority");
        });

        if (!isActive) {
          allTasks.forEach(taskEl => taskEl.style.display = "");
        }
      }
    });

    // Edit button
    const editBtn = document.createElement("button");
    editBtn.classList.add("edit-button");
    editBtn.style.cursor = "pointer";
    editBtn.title = "Edit task";
    editBtn.innerHTML = `✏️`;
editBtn.setAttribute('aria-label', 'Edit task');


    editBtn.addEventListener("click", async () => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = span.getAttribute("data-raw");
      input.className = "task-edit-input";

      categoryLabel.style.display = "none";
      priorityLabel.style.display = "none";
      dueDateDisplay.style.display = "none";
      dueDateInput.style.display = "none";
      timerDisplay.style.display = "none";
      startTimerBtn.style.display = "none";
      stopTimerBtn.style.display = "none";

      span.replaceWith(input);
      input.focus();

      async function save() {
        const val = input.value.trim();
        if (val !== "") {
          span.innerHTML = marked.parse(val);
          span.setAttribute("data-raw", val);
          span.className = "task-text";
          if (currentUser) {
              const { error } = await supabase
                .from("tasks")
                .update({ content: val })
                .eq("id", task.id)
                .eq("user_id", currentUser.id);
              if (error) console.error("Failed to update task content (Supabase):", error.message);
          } else {
              let guestTasks = getGuestTasks();
              const taskIndex = guestTasks.findIndex(t => t.id == task.id);
              if (taskIndex !== -1) {
                  guestTasks[taskIndex].content = val;
                  saveGuestTasks(guestTasks);
              }
          }
        }
        input.replaceWith(span);

        categoryLabel.style.display = "";
        priorityLabel.style.display = "";
        dueDateDisplay.style.display = "";
        // dueDateInput.style.display = ""; // No need to explicitly show, display will handle it
        timerDisplay.style.display = "";
        startTimerBtn.style.display = "";
        stopTimerBtn.style.display = "";
      }

      input.addEventListener("blur", save);
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") {
          input.replaceWith(span);
          categoryLabel.style.display = "";
          priorityLabel.style.display = "";
          dueDateDisplay.style.display = "";
          // dueDateInput.style.display = "";
          timerDisplay.style.display = "";
          startTimerBtn.style.display = "";
          stopTimerBtn.style.display = "";
        }
      });
    });

    // Timer display
    const timerDisplay = document.createElement("span");
    timerDisplay.textContent = formatTime(parseInt(li.dataset.elapsed, 10) || 0);
    timerDisplay.classList.add("task-timer");

    // Timer buttons
    const startTimerBtn = document.createElement("button");
    startTimerBtn.textContent = "⏵";
    startTimerBtn.classList.add("timer-button");
    startTimerBtn.addEventListener("click", () => startTaskTimer(li));


    const stopTimerBtn = document.createElement("button");
    stopTimerBtn.textContent = "⏹";
    stopTimerBtn.classList.add("timer-button", "stop");
    stopTimerBtn.disabled = true;
    stopTimerBtn.addEventListener("click", () => stopTaskTimer(li));

    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "X";
    deleteBtn.classList.add("delete-button");
    deleteBtn.addEventListener("click", async () => {
      showCustomConfirm("Are you sure you want to delete this task?", async () => { // Replaced confirm
          const taskId = li.dataset.taskId;
          if (activeTaskId && activeTaskId.dataset.taskId === taskId) {
            stopTaskTimer(li);
          }

          await deleteTask(taskId); // Call the conditional deleteTask

          taskList.removeChild(li);
          updateTaskCounter();
      });
    });


    // Drag & drop handlers
    li.addEventListener("dragstart", e => {
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", null); // Set data to bypass Firefox issue
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      [...taskList.children].forEach(item => item.classList.remove("dragover"));
      updateTaskPositionsInDB(); // Save positions after dragend
    });
    li.addEventListener("dragover", e => {
      e.preventDefault();
      const dragging = taskList.querySelector(".dragging");
      if (li === dragging) return;

      [...taskList.children].forEach(item => {
          item.classList.remove("dragover");
          item.style.borderTop = "";
          item.style.borderBottom = "";
      });

      const rect = li.getBoundingClientRect();
      const offset = e.clientY - rect.top;

      if (offset < rect.height / 2) {
        li.classList.add("dragover");
        li.style.borderTop = "2px solid var(--highlight-color)";
      } else {
        li.classList.add("dragover");
        li.style.borderBottom = "2px solid var(--highlight-color)";
      }
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("dragover");
      li.style.borderTop = "";
      li.style.borderBottom = "";
    });
    li.addEventListener("drop", e => {
      e.preventDefault();
      const dragging = taskList.querySelector(".dragging");
      if (!dragging || dragging === li) return;

      li.classList.remove("dragover");
      li.style.borderTop = "";
      li.style.borderBottom = "";

      const rect = li.getBoundingClientRect();
      const offset = e.clientY - rect.top;

      if (offset < rect.height / 2) {
        taskList.insertBefore(dragging, li);
      } else {
        taskList.insertBefore(dragging, li.nextSibling);
      }
      // Positions will be updated in dragend
    });

    // Append elements
    li.appendChild(checkbox);
    li.appendChild(span);
    li.appendChild(editBtn);
    li.appendChild(dueDateDisplay); // Append the display first
    li.appendChild(dueDateInput); // Append the input (hidden)
    li.appendChild(categoryLabel);
    li.appendChild(priorityLabel);
    li.appendChild(timerDisplay);
    li.appendChild(startTimerBtn);
    li.appendChild(stopTimerBtn);
    li.appendChild(deleteBtn);

    return li;
  }

async function addTaskFromInput() {
    const taskInput = document.getElementById("taskInput");
    const categorySelect = document.getElementById("categorySelect");
    const prioritySelect = document.getElementById("prioritySelect");
    const dueDateInput = document.getElementById("taskDueDate"); // Get the new due date input
    const taskList = document.getElementById("taskList");

    const taskText = taskInput.value.trim();
    if (!taskText) return;

    const category = categorySelect.value;
    const priority = prioritySelect.value;
    const dueDate = dueDateInput.value || null; // Get the due date

    const newTask = await addTask(taskText, category, priority, dueDate);
    if (!newTask) return;

    const li = createTaskElement(newTask);
    taskList.appendChild(li);

    taskInput.value = "";
    categorySelect.value = "Personal";
    prioritySelect.value = "Medium";
    dueDateInput.value = ""; // Clear due date input
    updateTaskCounter();
}


// --- Custom Alert/Confirm Modals (replacing native alert/confirm) ---
function showCustomAlert(message) {
    const modal = document.createElement('div');
    modal.classList.add('custom-modal');
    modal.innerHTML = `
        <div class="custom-modal-content">
            <p>${message}</p>
            <button class="custom-modal-button">OK</button>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('.custom-modal-button').addEventListener('click', () => {
        document.body.removeChild(modal);
    });
    // Optional: Close on outside click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
}

function showCustomConfirm(message, onConfirm) {
    const modal = document.createElement('div');
    modal.classList.add('custom-modal');
    modal.innerHTML = `
        <div class="custom-modal-content">
            <p>${message}</p>
            <div class="custom-modal-actions">
                <button class="custom-modal-button confirm-button">Yes</button>
                <button class="custom-modal-button cancel-button">No</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('.confirm-button').addEventListener('click', () => {
        document.body.removeChild(modal);
        onConfirm();
    });

    modal.querySelector('.cancel-button').addEventListener('click', () => {
        document.body.removeChild(modal);
    });
    // Optional: Close on outside click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
}

// Custom Prompt Modal (replacing native prompt)
function showCustomPrompt(message, onConfirm, defaultValue = '') {
    const modal = document.createElement('div');
    modal.classList.add('custom-modal');
    modal.innerHTML = `
        <div class="custom-modal-content">
            <p>${message}</p>
            <input type="text" class="custom-modal-input" value="${defaultValue}">
            <div class="custom-modal-actions">
                <button class="custom-modal-button confirm-button">OK</button>
                <button class="custom-modal-button cancel-button">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const input = modal.querySelector('.custom-modal-input');
    input.focus();

    modal.querySelector('.confirm-button').addEventListener('click', () => {
        document.body.removeChild(modal);
        onConfirm(input.value);
    });

    modal.querySelector('.cancel-button').addEventListener('click', () => {
        document.body.removeChild(modal);
        onConfirm(null); // Indicate cancellation
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            modal.querySelector('.confirm-button').click();
        } else if (e.key === 'Escape') {
            modal.querySelector('.cancel-button').click();
        }
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
            onConfirm(null); // Indicate cancellation if clicked outside
        }
    });
}


// --- Main Init Function ---
function init() {
  console.log("App initialized ✅");

  // Initial check for user and load app content
  checkUserAndLoadApp();

  // NEW: Request notification permission when the app initializes
  requestNotificationPermission();

  // --- Auth Section Event Listeners ---
  document.getElementById("signUpBtn")?.addEventListener("click", async (event) => {
      event.preventDefault();
      const email = document.getElementById("emailInput").value;
      const password = document.getElementById("passwordInput").value;
      await signUpUser(email, password);
  });

  document.getElementById("signInBtn")?.addEventListener("click", async (event) => {
      event.preventDefault();
      const email = document.getElementById("emailInput").value;
      const password = document.getElementById("passwordInput").value;
      await signInUser(email, password);
  });

  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    await signOutUser();
  });

  document.getElementById("sendResetEmailBtn")?.addEventListener("click", async () => {
    const email = document.getElementById("emailInput").value;
    await resetPasswordForEmailUser(email);
  });

  // --- Timer Event Listeners ---
  if (setButton) setButton.addEventListener("click", setTimer);
  if (startButton) startButton.addEventListener("click", startTimer);
  if (stopButton) stopButton.addEventListener("click", stopTimer);
  updateTimerDisplay(); // Initial display


  // --- Task Input and Add Button ---
  const addTaskButton = document.getElementById("addTaskButton");
  const taskInput = document.getElementById("taskInput");

  if (addTaskButton) addTaskButton.addEventListener("click", addTaskFromInput);
  if (taskInput) taskInput.addEventListener("keypress", e => {
    if (e.key === "Enter") addTaskFromInput();
  });


  // --- Sidebar Notes Toggle ---
  const toggleNotesBtn = document.getElementById("toggleNotes");
  const notesSidebar = document.getElementById("notesSidebar");
  const closeNotesBtn = document.getElementById("closeNotes");
  const notesInput = document.getElementById('notes');
  const notesOutput = document.getElementById('sidebar-notes-output');


  toggleNotesBtn?.addEventListener("click", () => {
    notesSidebar?.classList.add("open");
    if (toggleNotesBtn) toggleNotesBtn.style.display = "none";
    document.body.classList.add("notes-open");
    loadNote().then(() => renderNotesMarkdown()); // Load and then render
  });

  closeNotesBtn?.addEventListener("click", () => {
    notesSidebar?.classList.remove("open");
    if (toggleNotesBtn) toggleNotesBtn.style.display = "block";
    document.body.classList.remove("notes-open");
    if (notesInput) saveNote(notesInput.value); // Save note content when closing sidebar
  });

  function renderNotesMarkdown() {
    if (notesInput && notesOutput) {
      const markdown = notesInput.value;
      const html = marked.parse(markdown);
      notesOutput.innerHTML = html;
    }
  }
  notesInput?.addEventListener('input', renderNotesMarkdown);
  notesInput?.addEventListener('blur', () => { // Save on blur
      if (notesInput) saveNote(notesInput.value);
  });


  // --- Reset / Clear Buttons ---
  const taskList = document.getElementById("taskList");

  document.getElementById('resetCountBtn')?.addEventListener('click', async () => {
    showCustomConfirm("Are you sure you want to delete ALL tasks? This cannot be undone.", async () => { // Replaced confirm
        if (currentUser) {
            const { error } = await supabase.from('tasks').delete().eq('user_id', currentUser.id);
            if (error) console.error("Error resetting all tasks for user:", error.message);
            else {
                renderTasks([]); // Clear UI
                updateTaskCounter();
                showCustomAlert("All tasks reset for your account."); // Replaced alert
            }
        } else {
            saveGuestTasks([]); // Clear localStorage tasks
            renderTasks([]); // Clear UI
            updateTaskCounter();
            showCustomAlert("All tasks reset for guest mode (on this device)."); // Replaced alert
        }
    });
  });

  document.getElementById('clearFinishedBtn')?.addEventListener('click', async () => {
    const finishedTasksElements = taskList.querySelectorAll('li.finished');
    const tasksToDeleteIds = [];

    finishedTasksElements.forEach(li => {
      const taskId = li.dataset.taskId;
      if (taskId) {
        tasksToDeleteIds.push(Number(taskId));
      }
      li.remove(); // Remove from DOM immediately
    });

    if (tasksToDeleteIds.length > 0) {
      if (currentUser) {
        const { error } = await supabase
          .from("tasks")
          .delete()
          .in("id", tasksToDeleteIds)
          .eq("user_id", currentUser.id);

        if (error) console.error("Failed to delete finished tasks from Supabase:", error.message);
        else console.log("Finished tasks deleted from Supabase.");
      } else {
        let guestTasks = getGuestTasks();
        guestTasks = guestTasks.filter(task => !tasksToDeleteIds.includes(task.id));
        saveGuestTasks(guestTasks);
      }
    }
    await updateTaskPositionsInDB(); // Update positions after deleting finished tasks
    updateTaskCounter();
  });

  // --- Category and Priority Custom Options ---
  const categorySelect = document.getElementById("categorySelect");
  const prioritySelect = document.getElementById("prioritySelect");

  categorySelect?.addEventListener("change", () => {
    if (categorySelect.value === "__custom__") {
      showCustomPrompt("Enter new category name:", (newCategory) => { // Replaced prompt
          if (newCategory && newCategory.trim()) {
            const trimmedCategory = newCategory.trim();
            const exists = Array.from(categorySelect.options).some(
              option => option.value.toLowerCase() === trimmedCategory.toLowerCase()
            );
            if (!exists) {
              const newOption = document.createElement("option");
              newOption.value = trimmedCategory;
              newOption.textContent = trimmedCategory;
              categorySelect.insertBefore(newOption, categorySelect.lastElementChild);
              categorySelect.value = trimmedCategory;
            } else {
              showCustomAlert("That category already exists."); // Replaced alert
              categorySelect.value = "Personal";
            }
          } else {
            categorySelect.value = "Personal";
          }
      }, "Personal");
    }
  });

  prioritySelect?.addEventListener("change", () => {
    if (prioritySelect.value === "__custom__") {
      showCustomPrompt("Enter new priority:", (newPriority) => { // Replaced prompt
          if (newPriority && newPriority.trim()) {
            const trimmedPriority = newPriority.trim();
            const exists = Array.from(prioritySelect.options).some(
              opt => opt.value.toLowerCase() === trimmedPriority.toLowerCase()
            );
            if (!exists) {
              const newOption = document.createElement("option");
              newOption.value = trimmedPriority;
              newOption.textContent = trimmedPriority;
              prioritySelect.insertBefore(newOption, prioritySelect.lastElementChild);
              prioritySelect.value = trimmedPriority;
            } else {
              showCustomAlert("That priority already exists."); // Replaced alert
              prioritySelect.value = "Medium";
            }
          } else {
            prioritySelect.value = "Medium";
          }
      }, "Medium");
    }
  });

} // End of init()

// Init on DOM ready
window.addEventListener("DOMContentLoaded", init);