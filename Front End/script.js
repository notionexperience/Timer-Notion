import { supabase } from './supabase-init.js';

let currentUser = null; // null if guest, user object if logged in
const LOCAL_STORAGE_KEY_TASKS = 'focusflow_guest_tasks';
const LOCAL_STORAGE_KEY_NOTES = 'focusflow_guest_notes';

// --- Global object to store notification timers ---
// This is crucial for being able to cancel scheduled notifications.
// Key: task ID, Value: setTimeout ID
const notificationTimers = {};

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
            // Ensure due_date is correctly formatted as ISO string if it exists
            due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
            position: task.position || 0,
            notification_time: task.notification_time || null, 
        }));

        const { error: tasksError } = await supabase.from("tasks").insert(tasksToInsert, { ignoreDuplicates: true });
        if (tasksError) {
            console.error("Error migrating guest tasks:", tasksError.message);
        } else {
            console.log("Guest tasks migrated successfully.");
            localStorage.removeItem(LOCAL_STORAGE_KEY_TASKS);
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
            localStorage.removeItem(LOCAL_STORAGE_KEY_NOTES);
        }
    }
}


// --- Supabase Interaction Functions ---

async function signInUser(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("Login failed:", error.message);
    showCustomAlert("Login failed: " + error.message); 
  } else {
    console.log("Logged in:", data);
    await migrateGuestDataToSupabase();
    await checkUserAndLoadApp();
    requestNotificationPermission(); 
  }
}

async function signUpUser(email, password) {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) {
    console.error("Signup failed:", error.message);
    showCustomAlert("Signup failed: " + error.message); 
  } else {
    showCustomAlert("Signup successful – check your email to confirm"); 
    await migrateGuestDataToSupabase();
    await checkUserAndLoadApp();
    requestNotificationPermission();
  }
}

async function signOutUser() {
  await supabase.auth.signOut();
  currentUser = null;
  clearAllScheduledNotifications();
  location.reload();
}

async function resetPasswordForEmailUser(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + "/reset.html"
  });

  if (error) {
    showCustomAlert("Error sending password setup email: " + error.message); 
  } else {
    showCustomAlert("Check your inbox to set your password."); 
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

    requestNotificationPermission();

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
            .order("position", { ascending: true })
            .order("created_at", { ascending: false });

        if (error) {
            console.error("Failed to load tasks from Supabase:", error.message);
            return;
        }
        tasks = supabaseTasks;
        console.log("Loaded tasks from Supabase:", tasks);
    } else {
        tasks = getGuestTasks();
        tasks.sort((a, b) => (a.position || 0) - (b.position || 0) || (new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
        console.log("Loaded tasks from Local Storage (Guest Mode):", tasks);
    }
    renderTasks(tasks);
    updateTaskCounter();
    if (currentUser) {
        scheduleAllTaskNotifications(tasks);
    }
}

// Modified addTask to accept full ISO date-time string
async function addTask(content, category = "Personal", priority = "Medium", dueDateTime = null, notificationTime = null) {
    let newTask = null;
    const taskList = document.getElementById("taskList");
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
                due_date: dueDateTime, // Store as full ISO string
                position: lastTaskPosition,
                notification_time: notificationTime,
            },
        ]).select();

        if (error) {
            console.error("Add task to Supabase failed:", error.message);
            return null;
        }
        newTask = data[0];
        scheduleTaskNotification(newTask);
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
            due_date: dueDateTime, // Store as full ISO string
            position: lastTaskPosition,
            notification_time: notificationTime,
        };
        guestTasks.push(newTask);
        saveGuestTasks(guestTasks);
        console.log("Added task to Local Storage (Guest Mode):", newTask);
    }
    return newTask;
}

async function deleteTask(id) {
    clearScheduledNotification(id);

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
    await updateTaskPositionsInDB();
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
    for (const task of tasksInOrder) {
        const { error } = await supabase
            .from("tasks")
            .update({ position: task.position })
            .eq("id", task.id)
            .eq("user_id", currentUser.id);
        if (error) {
            console.error(`Failed to update position for task ${task.id} in Supabase:`, error.message);
        }
    }
        console.log("Task positions updated in Supabase.");
    } else {
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

const timerEndSound = document.getElementById('timerEndSound');

function requestNotificationPermission() {
    if ("Notification" in window && Notification.permission !== "granted") {
        Notification.requestPermission().then(permission => {
            if (permission === "granted") {
                console.log("Notification permission granted.");
            } else if (permission === "denied") {
                console.warn("Notification permission denied. Please enable notifications for this site in your browser settings if you want them.");
                showCustomAlert("Notification permission denied. Please enable notifications for this site in your browser settings if you want them.");
            }
        }).catch(error => {
            console.error("Error requesting notification permission:", error);
        });
    } else if (!("Notification" in window)) {
        console.warn("Browser does not support desktop notifications.");
    }
}

function timerFinished() {
    if (timerEndSound) {
        timerEndSound.play().catch(e => console.error("Error playing sound:", e));
    }

    if ("Notification" in window && Notification.permission === "granted") {
        new Notification("FocusFlow Timer", {
            body: "Your main timer has finished!",
            icon: "./assets/logo.png"
        });
    } else {
        showCustomAlert("Time's up!");
    }

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
    timerFinished();
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
let activeTaskId = null;

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function stopTaskTimerIfRunning(liToExclude) {
    if (activeTaskTimer && activeTaskId && activeTaskId.dataset.taskId !== liToExclude.dataset.taskId) {
        clearInterval(activeTaskTimer);
        const previousActiveLi = document.querySelector(`[data-task-id="${activeTaskId.dataset.taskId}"]`);
        if (previousActiveLi) {
            previousActiveLi.classList.remove("active-task");
            const buttons = previousActiveLi.querySelectorAll(".timer-button");
            if (buttons[0]) buttons[0].disabled = false;
            if (buttons[1]) buttons[1].disabled = true;
        }
        activeTaskTimer = null;
        activeTaskId = null;
    }
}

async function startTaskTimer(li) {
    if (li.classList.contains("finished")) return;
    if (activeTaskTimer && activeTaskId && activeTaskId.dataset.taskId === li.dataset.taskId) return;

    stopTaskTimerIfRunning(li);

    li.classList.add("active-task");
    const timerDisplay = li.querySelector(".task-timer");
    const startBtn = li.querySelector(".timer-button:not(.stop)");
    const stopBtn = li.querySelector(".timer-button.stop");

    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;

    activeTaskId = li;

    activeTaskTimer = setInterval(async () => {
        let elapsed = parseInt(li.dataset.elapsed, 10) || 0;
        elapsed++;
        li.dataset.elapsed = elapsed;
        if(timerDisplay) timerDisplay.textContent = formatTime(elapsed);

        const taskId = li.dataset.taskId;
        if (taskId && elapsed % 5 === 0) {
            if (currentUser) {
                const { error } = await supabase
                    .from("tasks")
                    .update({ elapsed: elapsed })
                    .eq("id", taskId)
                    .eq("user_id", currentUser.id);
                if (error) console.error("Failed to update elapsed time in Supabase:", error.message);
            } else {
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

async function stopTaskTimer(li) {
    if (activeTaskId && activeTaskId.dataset.taskId !== li.dataset.taskId) return;
    clearInterval(activeTaskTimer);
    activeTaskTimer = null;
    activeTaskId = null;

    li.classList.remove("active-task");

    const startBtn = li.querySelector(".timer-button:not(.stop)");
    const stopBtn = li.querySelector(".timer-button.stop");

    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;

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
            let guestTasks = getGuestTasks();
            const taskIndex = guestTasks.findIndex(t => t.id == Number(taskId));
            if (taskIndex !== -1) {
                guestTasks[taskIndex].elapsed = finalElapsed;
                saveGuestTasks(guestTasks);
            }
        }
    }
}

// Helper to get today's date in YYYY-MM-DD format (used for display/comparison only)
function getTodayDateString() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Function to schedule a single task notification
function scheduleTaskNotification(task) {
    // Only schedule if user is logged in, notification permission is granted, and task has a due date
    // and is not done. Notification time is optional.
    if (!currentUser || Notification.permission !== "granted" || !task.due_date || task.is_done) {
        clearScheduledNotification(task.id);
        return;
    }

    clearScheduledNotification(task.id); // Clear any existing notification for this task

    const dueDateTime = new Date(task.due_date); // due_date is now expected to be a full ISO string
    
    // If dueDateTime is invalid (e.g., only date was provided without time, or malformed)
    if (isNaN(dueDateTime.getTime())) {
        console.warn(`Invalid due_date for task ${task.id}: ${task.due_date}. Cannot schedule notification.`);
        return;
    }

    const notificationTimeOffset = task.notification_time !== null ? parseInt(task.notification_time, 10) : 15; // Default to 15 mins

    const notificationTimestamp = dueDateTime.getTime() - (notificationTimeOffset * 60 * 1000); // Subtract minutes in milliseconds

    const now = Date.now();
    const timeUntilNotification = notificationTimestamp - now;

    if (timeUntilNotification > 0) {
        console.log(`Scheduling notification for task "${task.content}" in ${timeUntilNotification / 1000 / 60} minutes.`);
        const timeoutId = setTimeout(() => {
            new Notification("FocusFlow Task Reminder", {
                body: `Task due soon: ${task.content} at ${new Date(task.due_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
                icon: "./assets/logo.png"
            });
            delete notificationTimers[task.id];
        }, timeUntilNotification);
        notificationTimers[task.id] = timeoutId;
    } else {
        console.log(`Notification for task "${task.content}" is in the past or too soon to schedule.`);
    }
}

function scheduleAllTaskNotifications(tasks) {
    clearAllScheduledNotifications();
    tasks.forEach(task => scheduleTaskNotification(task));
}

function clearScheduledNotification(taskId) {
    if (notificationTimers[taskId]) {
        clearTimeout(notificationTimers[taskId]);
        console.log(`Cleared scheduled notification for task ID: ${taskId}`);
        delete notificationTimers[taskId];
    }
}

function clearAllScheduledNotifications() {
    for (const taskId in notificationTimers) {
        clearTimeout(notificationTimers[taskId]);
    }
    console.log("Cleared all scheduled notifications.");
    Object.keys(notificationTimers).forEach(key => delete notificationTimers[key]);
}


function createTaskElement(task) {
    const li = document.createElement("li");
    li.draggable = true;

    li.dataset.category = task.category || "";
    li.dataset.elapsed = task.elapsed || 0;
    li.dataset.taskId = task.id;
    li.dataset.priority = task.priority || "Medium";
    li.dataset.position = task.position || 0;

    // Apply date-related classes (now considering full date-time)
    const taskDueDateTime = task.due_date ? new Date(task.due_date) : null;
    if (taskDueDateTime && !isNaN(taskDueDateTime.getTime())) {
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Normalize today to start of day

        const taskDateOnly = new Date(taskDueDateTime);
        taskDateOnly.setHours(0, 0, 0, 0); // Normalize task date to start of day

        const diffTime = taskDateOnly.getTime() - today.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        li.classList.remove("task-due-today", "task-overdue"); // Clear existing
        if (diffDays === 0) {
            li.classList.add('task-due-today');
        } else if (diffDays < 0) {
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
        clearScheduledNotification(task.id);
      } else {
        li.classList.remove("finished");
        const firstUnfinished = [...taskList.children].find(item => !item.classList.contains("finished"));
        if (firstUnfinished) {
          taskList.insertBefore(li, firstUnfinished);
        } else {
          taskList.prepend(li);
        }
        scheduleTaskNotification(task);
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
      await updateTaskPositionsInDB();
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
    dueDateDisplay.title = "Click to set/change due date and time";

    // Due Date Input
    const dueDateInput = document.createElement("input");
    dueDateInput.type = "date";
    dueDateInput.classList.add("date-input");
    // Extract date part if task.due_date is a full ISO string
    dueDateInput.value = task.due_date ? task.due_date.substring(0, 10) : '';
    dueDateInput.style.display = 'none';

    // NEW: Due Time Input
    const dueTimeInput = document.createElement("input");
    dueTimeInput.type = "time";
    dueTimeInput.classList.add("time-input"); // Add a class for styling
    // Extract time part if task.due_date is a full ISO string
    // Use toLocaleTimeString to get the local time in HH:MM format
    if (task.due_date) {
        const dateObj = new Date(task.due_date);
        if (!isNaN(dateObj.getTime())) {
            dueTimeInput.value = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        }
    }
    dueTimeInput.style.display = 'none';

    // Notification Time Display
    const notificationTimeDisplay = document.createElement("span");
    notificationTimeDisplay.classList.add("notification-time-display", "category-label");
    notificationTimeDisplay.style.cursor = "pointer";
    notificationTimeDisplay.title = "Click to set/change notification time (minutes before due)";

    // Notification Time Input
    const notificationTimeInput = document.createElement("input");
    notificationTimeInput.type = "number";
    notificationTimeInput.classList.add("input");
    notificationTimeInput.min = "0";
    notificationTimeInput.value = task.notification_time !== null ? task.notification_time : 15;
    notificationTimeInput.style.display = 'none';
    notificationTimeInput.placeholder = "🔔";


    function updateDueDateDisplayAndClasses() {
        if (task.due_date) {
            const dateObj = new Date(task.due_date);
            if (isNaN(dateObj.getTime())) { // Handle invalid dates
                dueDateDisplay.textContent = "📅 Invalid Date";
                li.classList.remove("task-due-today", "task-overdue");
                return;
            }

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const taskDateOnly = new Date(dateObj);
            taskDateOnly.setHours(0, 0, 0, 0);

            const diffTime = taskDateOnly.getTime() - today.getTime();
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            let dateString = dateObj.toLocaleDateString();
            let timeString = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            dueDateDisplay.textContent = `📅 ${dateString} ${timeString}`;
            li.classList.remove("task-due-today", "task-overdue");
            if (diffDays === 0) {
                li.classList.add('task-due-today');
            } else if (diffDays < 0) {
                li.classList.add('task-overdue');
            }
        } else {
            dueDateDisplay.textContent = "📅 No due date";
            li.classList.remove("task-due-today", "task-overdue");
        }
    }

    function updateNotificationTimeDisplay() {
        if (task.notification_time !== null && task.due_date) {
            notificationTimeDisplay.textContent = `🔔 ${task.notification_time} min`;
            notificationTimeDisplay.style.display = 'inline-block';
        } else {
            notificationTimeDisplay.textContent = `🔔 No notification`;
            notificationTimeDisplay.style.display = 'inline-block';
        }
    }

    // Function to save combined date and time
    async function saveDueDateTime() {
        const datePart = dueDateInput.value;
        const timePart = dueTimeInput.value;
        let newDueDateTime = null;

        if (datePart) {
            if (timePart) {
                // Combine date and time, then convert to ISO string (UTC)
                // This ensures consistency when saving to Supabase
                const combinedDateTime = new Date(`${datePart}T${timePart}:00`);
                if (!isNaN(combinedDateTime.getTime())) {
                    newDueDateTime = combinedDateTime.toISOString();
                }
            } else {
                // If only date is provided, default time to midnight local time
                const dateOnly = new Date(datePart);
                if (!isNaN(dateOnly.getTime())) {
                    dateOnly.setHours(0, 0, 0, 0); // Set to local midnight
                    newDueDateTime = dateOnly.toISOString();
                }
            }
        }
        
        task.due_date = newDueDateTime; // Update task object with full ISO string

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
                guestTasks[taskIndex].due_date = task.due_date;
                saveGuestTasks(guestTasks);
            }
        }
        updateDueDateDisplayAndClasses();
        updateNotificationTimeDisplay();
        scheduleTaskNotification(task);
    }


    dueDateDisplay.addEventListener("click", () => {
        dueDateDisplay.style.display = 'none';
        dueDateInput.style.display = 'inline-block';
        dueTimeInput.style.display = 'inline-block'; // Show time input too
        dueDateInput.focus();
    });

    dueDateInput.addEventListener("change", saveDueDateTime);
    dueTimeInput.addEventListener("change", saveDueDateTime); // Listen to time input changes

    // FIX: Only hide if neither date, time, nor notification input is focused
    dueDateInput.addEventListener("blur", () => {
        // Use a small timeout to allow focus to shift to another input within the same task item
        setTimeout(() => {
            if (document.activeElement !== dueTimeInput && document.activeElement !== notificationTimeInput && document.activeElement !== dueDateInput) {
                dueDateInput.style.display = 'none';
                dueTimeInput.style.display = 'none';
                dueDateDisplay.style.display = 'inline-block';
                updateDueDateDisplayAndClasses();
            }
        }, 50); // Small delay
    });

    // FIX: Only hide if neither date, time, nor notification input is focused
    dueTimeInput.addEventListener("blur", () => {
        setTimeout(() => {
            if (document.activeElement !== dueDateInput && document.activeElement !== notificationTimeInput && document.activeElement !== dueTimeInput) {
                dueDateInput.style.display = 'none';
                dueTimeInput.style.display = 'none';
                dueDateDisplay.style.display = 'inline-block';
                updateDueDateDisplayAndClasses();
            }
        }, 50); // Small delay
    });


    notificationTimeDisplay.addEventListener("click", () => {
        notificationTimeDisplay.style.display = 'none';
        notificationTimeInput.style.display = 'inline-block';
        notificationTimeInput.focus();
    });

    notificationTimeInput.addEventListener("change", async () => {
        const newNotificationTime = parseInt(notificationTimeInput.value, 10);
        task.notification_time = isNaN(newNotificationTime) ? null : newNotificationTime;

        if (currentUser) {
            const { error } = await supabase
                .from("tasks")
                .update({ notification_time: task.notification_time })
                .eq("id", task.id)
                .eq("user_id", currentUser.id);
            if (error) console.error("Failed to update notification time (Supabase):", error.message);
        } else {
            let guestTasks = getGuestTasks();
            const taskIndex = guestTasks.findIndex(t => t.id == task.id);
            if (taskIndex !== -1) {
                guestTasks[taskIndex].notification_time = task.notification_time;
                saveGuestTasks(guestTasks);
            }
        }
        updateNotificationTimeDisplay();
        scheduleTaskNotification(task);
    });

    // FIX: Only hide if neither date nor time input is focused
    notificationTimeInput.addEventListener("blur", () => {
        setTimeout(() => {
            if (document.activeElement !== dueDateInput && document.activeElement !== dueTimeInput && document.activeElement !== notificationTimeInput) {
                notificationTimeInput.style.display = 'none';
                notificationTimeDisplay.style.display = 'inline-block';
                updateNotificationTimeDisplay();
            }
        }, 50); // Small delay
    });


    updateDueDateDisplayAndClasses();
    updateNotificationTimeDisplay();


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
        ["Personal", "Home", "Work", "Health", "Finance"].forEach(optionText => {
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
        ["Scheduled", "Urgent", "High", "Medium", "Low"] .forEach(optionText => {
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
      dueTimeInput.style.display = "none"; // NEW: Hide time input
      notificationTimeDisplay.style.display = "none";
      notificationTimeInput.style.display = "none";
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
        notificationTimeDisplay.style.display = "";
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
          notificationTimeDisplay.style.display = "";
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
      showCustomConfirm("Are you sure you want to delete this task?", async () => {
          const taskId = li.dataset.taskId;
          if (activeTaskId && activeTaskId.dataset.taskId === taskId) {
            stopTaskTimer(li);
          }

          await deleteTask(taskId);

          taskList.removeChild(li);
          updateTaskCounter();
      });
    });


    // Drag & drop handlers
    li.addEventListener("dragstart", e => {
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", null);
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      [...taskList.children].forEach(item => item.classList.remove("dragover"));
      updateTaskPositionsInDB();
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
    });

    // Append elements
    li.appendChild(checkbox);
    li.appendChild(span);
    li.appendChild(editBtn);
    li.appendChild(dueDateDisplay);
    li.appendChild(dueDateInput);
    li.appendChild(dueTimeInput); // NEW: Append time input
    li.appendChild(notificationTimeDisplay);
    li.appendChild(notificationTimeInput);
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
    const dueDateInput = document.getElementById("taskDueDate");
    const dueTimeInput = document.getElementById("taskDueTime"); // NEW: Get time input
    const notificationTimeInput = document.getElementById("notificationTimeInput");
    const taskList = document.getElementById("taskList");

    const taskText = taskInput.value.trim();
    if (!taskText) return;

    const category = categorySelect.value;
    const priority = prioritySelect.value;
    
    // Combine date and time into a single ISO string
    let dueDateTime = null;
    const datePart = dueDateInput.value;
    const timePart = dueTimeInput.value;
    if (datePart) {
        if (timePart) {
            // Combine date and time, then convert to ISO string (UTC)
            const combinedDateTime = new Date(`${datePart}T${timePart}:00`);
            if (!isNaN(combinedDateTime.getTime())) {
                dueDateTime = combinedDateTime.toISOString();
            }
        } else {
            // If only date is provided, default time to midnight local time
            const dateOnly = new Date(datePart);
            if (!isNaN(dateOnly.getTime())) {
                dateOnly.setHours(0, 0, 0, 0); // Set to local midnight
                dueDateTime = dateOnly.toISOString();
            }
        }
    }

    const notificationTime = notificationTimeInput.value ? parseInt(notificationTimeInput.value, 10) : null;

    const newTask = await addTask(taskText, category, priority, dueDateTime, notificationTime);
    if (!newTask) return;

    const li = createTaskElement(newTask);
    taskList.appendChild(li);

    taskInput.value = "";
    categorySelect.value = "Personal";
    prioritySelect.value = "Medium";
    dueDateInput.value = "";
    dueTimeInput.value = ""; // NEW: Clear time input
    notificationTimeInput.value = "15";
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
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
}

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
        onConfirm(null);
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
            onConfirm(null);
        }
    });
}


// --- Main Init Function ---
function init() {
  console.log("App initialized ✅");

  checkUserAndLoadApp();

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
  updateTimerDisplay();


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
    loadNote().then(() => renderNotesMarkdown());
  });

  closeNotesBtn?.addEventListener("click", () => {
    notesSidebar?.classList.remove("open");
    if (toggleNotesBtn) toggleNotesBtn.style.display = "block";
    document.body.classList.remove("notes-open");
    if (notesInput) saveNote(notesInput.value);
  });

  function renderNotesMarkdown() {
    if (notesInput && notesOutput) {
      const markdown = notesInput.value;
      const html = marked.parse(markdown);
      notesOutput.innerHTML = html;
    }
  }
  notesInput?.addEventListener('input', renderNotesMarkdown);
  notesInput?.addEventListener('blur', () => {
      if (notesInput) saveNote(notesInput.value);
  });


  // --- Reset / Clear Buttons ---
  const taskList = document.getElementById("taskList");

  document.getElementById('resetCountBtn')?.addEventListener('click', async () => {
    showCustomConfirm("Are you sure you want to delete ALL tasks?", async () => {
        if (currentUser) {
            const { error } = await supabase.from('tasks').delete().eq('user_id', currentUser.id);
            if (error) console.error("Error resetting all tasks for user:", error.message);
            else {
                renderTasks([]);
                updateTaskCounter();
                showCustomAlert("All tasks reset for your account.");
                clearAllScheduledNotifications();
            }
        } else {
            saveGuestTasks([]);
            renderTasks([]);
            updateTaskCounter();
            showCustomAlert("All tasks reset for guest mode (on this device).");
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
      li.remove();
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
      tasksToDeleteIds.forEach(id => clearScheduledNotification(id));
    }
    await updateTaskPositionsInDB();
    updateTaskCounter();
  });

  // --- Category and Priority Custom Options ---
  const categorySelect = document.getElementById("categorySelect");
  const prioritySelect = document.getElementById("prioritySelect");

  categorySelect?.addEventListener("change", () => {
    if (categorySelect.value === "__custom__") {
      showCustomPrompt("Enter new category name:", (newCategory) => {
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
              showCustomAlert("That category already exists.");
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
      showCustomPrompt("Enter new priority:", (newPriority) => {
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
              showCustomAlert("That priority already exists.");
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
