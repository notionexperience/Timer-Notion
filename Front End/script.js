import { supabase } from './supabase-init.js';

let currentUser = null; // null if guest, user object if logged in
const LOCAL_STORAGE_KEY_TASKS = 'focusflow_guest_tasks';
const LOCAL_STORAGE_KEY_NOTES = 'focusflow_guest_notes';

// --- Global object to store notification timers ---
// This is crucial for being able to cancel scheduled notifications.
// Key: task ID, Value: setTimeout ID
const notificationTimers = {};

// --- Global variable to store all tasks for filtering ---
let allTasks = [];

// NEW: Set to store IDs of tasks whose subtasks are currently expanded
const expandedTaskIds = new Set();

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
            // Ensure due_date is correctly formatted as ISO string if it exists
            due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
            position: task.position || 0,
            notification_time: task.notification_time || null,
            subtasks: task.subtasks || [], // Include subtasks
            attachments: task.attachments || [], // Include attachments
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
        // Fetch tasks, and include subtasks and attachments using the 'jsonb' columns
        const { data: supabaseTasks, error } = await supabase
            .from("tasks")
            .select("*, subtasks, attachments") // Select the jsonb columns
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
    allTasks = tasks; // Store all tasks in the global variable
    
    // Populate filter dropdowns with unique values from allTasks
    populateCategoryFilter(allTasks);
    populatePriorityFilter(allTasks);

    filterTasks(); // Apply filters and render tasks initially

    updateTaskCounter();
    if (currentUser) {
        scheduleAllTaskNotifications(allTasks);
    }

    // NEW: Reapply expanded state after rendering
    expandedTaskIds.forEach(taskId => {
        const taskElement = document.querySelector(`li[data-task-id="${taskId}"]`);
        if (taskElement) {
            const subtasksContainer = taskElement.querySelector(".subtasks-container");
            const toggleButton = taskElement.querySelector(".toggle-subtasks-button");
            if (subtasksContainer && toggleButton) {
                subtasksContainer.style.display = "block";
                toggleButton.classList.add("expanded");
                toggleButton.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-6">
                        <path fill-rule="evenodd" d="M11.47 7.72a.75.75 0 0 1 1.06 0l7.5 7.5a.75.75 0 1 1-1.06 1.06L12 9.31l-6.97 6.97a.75.75 0 0 1-1.06-1.06l7.5-7.5Z" clip-rule="evenodd" />
                    </svg>
                `;
            }
        }
    });
}

// Modified addTask to accept full ISO date-time string
async function addTask(content, category = "Personal", priority = "Medium", dueDateTime = null, notificationTime = null, attachments = []) {
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
                due_date: dueDateTime, // Store as full ISO string
                position: lastTaskPosition,
                notification_time: notificationTime, // This is expected to be minutes offset
                subtasks: [], // Initialize with an empty array for subtasks (Supabase jsonb)
                attachments: attachments, // Store attachments (Supabase jsonb)
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
            id: Date.now(), // Use Date.now() for unique ID in guest mode
            content: content,
            is_done: false,
            category: category,
            priority: priority,
            created_at: new Date().toISOString(),
            due_date: dueDateTime, // Store as full ISO string
            position: lastTaskPosition,
            notification_time: notificationTime, // This is expected to be minutes offset
            subtasks: [], // Initialize with an empty array for subtasks
            attachments: attachments, // Store attachments
        };
        guestTasks.push(newTask);
        saveGuestTasks(guestTasks);
        console.log("Added task to Local Storage (Guest Mode):", newTask);
    }
    return newTask;
}

// New function to update a task
async function updateTask(taskId, updates) {
    if (currentUser) {
        const { error } = await supabase
            .from("tasks")
            .update(updates)
            .eq("id", taskId)
            .eq("user_id", currentUser.id);
        if (error) console.error("Failed to update task in Supabase:", error.message);
    } else {
        let guestTasks = getGuestTasks();
        const taskIndex = guestTasks.findIndex(t => t.id == Number(taskId));
        if (taskIndex !== -1) {
            guestTasks[taskIndex] = { ...guestTasks[taskIndex], ...updates };
            saveGuestTasks(guestTasks);
        }
    }
    // If due_date or notification_time is updated, reschedule notification
    if (updates.due_date !== undefined || updates.notification_time !== undefined) {
        // Fetch the updated task to ensure all fields are current for scheduling
        let currentTask = null;
        if (currentUser) {
            const { data, error } = await supabase.from("tasks").select("*").eq("id", taskId).single();
            if (!error) currentTask = data;
        } else {
            currentTask = getGuestTasks().find(t => t.id == Number(taskId));
        }

        if (currentTask) {
            scheduleTaskNotification(currentTask);
        }
    }
}


async function deleteTask(id) {
    clearScheduledNotification(id);

    if (currentUser) {
        // Optional: If you implement actual Supabase Storage, you might want to
        // delete associated files from storage here before deleting the task.
        // This would require fetching the task's attachments first.

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

        if (error && error.code !== 'PGRST116') { // PGRST116 means no rows found
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

function renderTasks(tasksToRender) {
  const taskList = document.getElementById("taskList");
  if (!taskList) {
    console.error("Task list element not found!");
    return;
  }
  taskList.innerHTML = "";
  tasksToRender.forEach(task => {
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
    counterSpan.textContent = ` Tasks: ${finishedTasks} / ${totalTasks} completed`;
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
    // Only schedule if user is logged in, task has a due date, and is not done.
    if (!task.due_date || task.is_done) {
        clearScheduledNotification(task.id);
        return;
    }

    clearScheduledNotification(task.id); // Clear any existing notification for this task

    const dueDateTime = new Date(task.due_date);

    // If dueDateTime is invalid (e.g., only date was provided without time, or malformed)
    if (isNaN(dueDateTime.getTime())) {
        console.warn(`Invalid due_date for task ${task.id}: ${task.due_date}. Cannot schedule notification.`);
        return;
    }

    // Default to 15 minutes before, or use the task's specified offset
    const notificationTimeOffset = task.notification_time !== null ? parseInt(task.notification_time, 10) : 15;

    // Calculate the exact timestamp for the notification
    const notificationTimestamp = dueDateTime.getTime() - (notificationTimeOffset * 60 * 1000);

    const now = Date.now();
    const timeUntilNotification = notificationTimestamp - now;

    if (timeUntilNotification > 0) {
        console.log(`Scheduling in-app notification for task "${task.content}" in ${timeUntilNotification / 1000 / 60} minutes.`);
        const timeoutId = setTimeout(() => {
            const formattedDueTime = new Date(task.due_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const notificationMessage = `${task.content} at ${formattedDueTime}`;

            // Only show in-app custom alert
            showCustomAlert(`🔔 ${notificationMessage}`);

            // Play a notification sound
            try {
                // Ensure you have a sound file at this path, e.g., assets/notification.mp3
                const notificationSound = new Audio('/Sounds/notification-sound-effect-372475.mp3');
                notificationSound.play().catch(e => console.error("Error playing notification sound:", e));
            } catch (e) {
                console.error("Could not create Audio object for notification sound:", e);
            }
            
            delete notificationTimers[task.id];
        }, timeUntilNotification);
        notificationTimers[task.id] = timeoutId;
    } else {
        console.log(`In-app notification for task "${task.content}" is in the past or too soon to schedule.`);
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

// Variable to hold the currently dragged list item
let draggedItem = null;

function createTaskElement(task) {
    const li = document.createElement("li");
    li.draggable = true;

    li.dataset.category = task.category || "";
    li.dataset.taskId = task.id;
    li.dataset.priority = task.priority || "Medium";
    li.dataset.position = task.position || 0;
    li.dataset.createdAt = task.created_at; // Store creation date for sorting

    if (task.is_done) {
        li.classList.add("finished");
    }

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
        if (diffDays < 0) { // Overdue
            li.classList.add('overdue-task');
        } else if (diffDays === 0) { // Due Today
            li.classList.add('today-task');
        } else { // Future
            li.classList.add('future-task');
        }
    } else {
        li.classList.add('no-due-date');
    }


    // Checkbox
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.is_done || false;

    checkbox.addEventListener("change", async () => {
      const taskId = li.dataset.taskId;
      const isChecked = checkbox.checked;

      if (taskId) {
        await updateTask(taskId, { is_done: isChecked });
      }
      // Reload tasks to re-render with updated completion status and apply filters/sorting
      await loadTasks(); 
    });
    li.appendChild(checkbox);

    // Task Content
    const span = document.createElement("span");
    span.classList.add("task-text");
    span.innerHTML = marked.parse(task.content || "");
    span.setAttribute("data-raw", task.content || "");
    li.appendChild(span);
    
    // NEW: Attachment Icon for task list item
    if (task.attachments && task.attachments.length > 0) {
        const attachmentIcon = document.createElement("span");
        attachmentIcon.classList.add("attachment-icon"); // Add a class for styling
        attachmentIcon.innerHTML = `🗂️`; // Paperclip icon
        attachmentIcon.title = "View attachments";
        attachmentIcon.style.cursor = "pointer";
        attachmentIcon.addEventListener("click", () => {
            let attachmentListHtml = "<h3>Attachments:</h3><ul>";
            task.attachments.forEach(att => {
                attachmentListHtml += `<li><a href="${att.url}" target="_blank" rel="noopener noreferrer">${att.name}</a></li>`;
            });
            attachmentListHtml += "</ul>";
            showCustomAlert(attachmentListHtml);
        });
        li.appendChild(attachmentIcon);
    }
    // NEW: Subtask Progress Display
    const subtaskProgressDisplay = document.createElement("span");
    subtaskProgressDisplay.classList.add("subtask-progress-display");
    if (task.subtasks && task.subtasks.length > 0) {
        const completedSubtasks = task.subtasks.filter(st => st.is_done).length;
        subtaskProgressDisplay.textContent = `✅ ${completedSubtasks}/${task.subtasks.length}`;
    } else {
        subtaskProgressDisplay.textContent = ``; // No display if no subtasks
    }
    li.appendChild(subtaskProgressDisplay);
    
    // Notification Time Display
    const notificationTimeDisplay = document.createElement("span");
    notificationTimeDisplay.classList.add("notification-time-display");
    if (task.notification_time !== null && task.notification_time > 0 && task.due_date) {
        const dueDateTime = new Date(task.due_date);
        if (!isNaN(dueDateTime.getTime())) {
            const notificationTimestamp = dueDateTime.getTime() - (task.notification_time * 60 * 1000);
            const actualNotificationTime = new Date(notificationTimestamp);
            notificationTimeDisplay.textContent = `🔔 ${actualNotificationTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        } else {
            notificationTimeDisplay.textContent = `🔔 Invalid Due Date for Notification`;
        }
    } else {
        notificationTimeDisplay.textContent = ``;
    }
    li.appendChild(notificationTimeDisplay); // Appended after dueDateDisplay

    // Due Date Display
    const dueDateDisplay = document.createElement("span");
    dueDateDisplay.classList.add("due-date-display");
    if (taskDueDateTime && !isNaN(taskDueDateTime.getTime())) {
        let dateString = taskDueDateTime.toLocaleDateString();
        let timeString = '';
        if (taskDueDateTime.getUTCHours() !== 0 || taskDueDateTime.getUTCMinutes() !== 0) {
             timeString = taskDueDateTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        dueDateDisplay.textContent = `📅 ${dateString}` + (timeString ? ` ${timeString}` : '');
    } else {
        dueDateDisplay.textContent = "📅 No due date";
    }
    li.appendChild(dueDateDisplay); // Appended after priorityLabel


    // Category label - MOVED HERE
    const categoryLabel = document.createElement("span");
    categoryLabel.classList.add("category-label");
    categoryLabel.textContent = `🏷️ ${task.category || "Personal"}`;
    categoryLabel.dataset.category = task.category || "";
    categoryLabel.style.cursor = "pointer";
    categoryLabel.title = `Filter by ${task.category || "Personal"}`;

    categoryLabel.addEventListener("click", (e) => {
      const categoryFilter = document.getElementById("categoryFilter");
      if (categoryFilter) {
        categoryFilter.value = task.category || "all";
        filterTasks(); // Re-run filter with the selected category
      }
    });
    li.appendChild(categoryLabel); // Appended after span

    // Priority label - MOVED HERE
    const priorityLabel = document.createElement("span");
    priorityLabel.classList.add("priority-label");
    priorityLabel.textContent = `⚡ ${task.priority || "Medium"}`;
    priorityLabel.style.cursor = "pointer";
    priorityLabel.title = `Filter by priority: ${task.priority || "Medium"}`;

    priorityLabel.addEventListener("click", (e) => {
      const priorityFilter = document.getElementById("priorityFilter");
      if (priorityFilter) {
        priorityFilter.value = task.priority || "all";
        filterTasks(); // Re-run filter with the selected priority
      }
    });
    li.appendChild(priorityLabel); // Appended after categoryLabel

    
    // Task Actions container
    const taskActions = document.createElement("div");
    taskActions.classList.add("task-actions");

    // Edit button - Now opens modal
    const editBtn = document.createElement("button");
    editBtn.classList.add("edit-button");
    editBtn.style.cursor = "pointer";
    editBtn.title = "Edit task";
    editBtn.innerHTML = `✏️`; // SVG for edit icon
    editBtn.setAttribute('aria-label', 'Edit task');
    editBtn.addEventListener("click", () => showEditModal(task)); // Call showEditModal
    taskActions.appendChild(editBtn);

    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = ""; // Text removed, using SVG
    deleteBtn.classList.add("delete-button");
    deleteBtn.innerHTML = `🗑️`; // SVG for delete icon
    deleteBtn.addEventListener("click", async () => {
      showCustomConfirm("Are you sure you want to delete this task?", async () => {
          const taskId = li.dataset.taskId;
          await deleteTask(taskId);
          // Instead of removing li directly, reload tasks to ensure search/filter state is consistent
          await loadTasks(); 
      });
    });
    taskActions.appendChild(deleteBtn);

    // Append Task Actions
    li.appendChild(taskActions);


    // Subtasks section
    const subtasksContainer = document.createElement("div");
    subtasksContainer.classList.add("subtasks-container");
    // Initially hide subtasks unless previously expanded
    if (expandedTaskIds.has(task.id)) {
        subtasksContainer.style.display = "block";
    } else {
        subtasksContainer.style.display = "none";
    }

    const subtaskInputGroup = document.createElement("div");
    subtaskInputGroup.classList.add("subtask-input-group");

    const subtaskInput = document.createElement("input");
    subtaskInput.type = "text";
    subtaskInput.placeholder = "Add a sub-task...";
    subtaskInput.classList.add("input", "subtask-input");

    const addSubtaskButton = document.createElement("button");
    addSubtaskButton.textContent = "Add Sub-task";
    addSubtaskButton.classList.add("button", "add-subtask-button");
    addSubtaskButton.addEventListener("click", async () => {
        const content = subtaskInput.value.trim();
        if (content) {
            await addSubTask(task.id, content);
            subtaskInput.value = "";
            await loadTasks(); // Reload to update UI with new subtask
        } else {
            showCustomAlert("Sub-task content cannot be empty.");
        }
    });
    subtaskInput.addEventListener("keypress", async (e) => {
        if (e.key === "Enter") {
            const content = subtaskInput.value.trim();
            if (content) {
                await addSubTask(task.id, content);
                subtaskInput.value = "";
                await loadTasks(); // Reload to update UI with new subtask
            } else {
                showCustomAlert("Sub-task content cannot be empty.");
            }
        }
    });

    subtaskInputGroup.appendChild(subtaskInput);
    subtaskInputGroup.appendChild(addSubtaskButton);
    subtasksContainer.appendChild(subtaskInputGroup);

    const subtaskList = document.createElement("ul");
    subtaskList.classList.add("subtask-list");
    subtasksContainer.appendChild(subtaskList);

    li.appendChild(subtasksContainer);

    // Expand/Collapse button for subtasks
    const toggleSubtasksBtn = document.createElement("button");
    toggleSubtasksBtn.classList.add("toggle-subtasks-button");
    // Set initial icon based on expanded state
    if (expandedTaskIds.has(task.id)) {
        toggleSubtasksBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-6">
                <path fill-rule="evenodd" d="M11.47 7.72a.75.75 0 0 1 1.06 0l7.5 7.5a.75.75 0 1 1-1.06 1.06L12 9.31l-6.97 6.97a.75.75 0 0 1-1.06-1.06l7.5-7.5Z" clip-rule="evenodd" />
            </svg>
        `; // Up arrow when expanded
        toggleSubtasksBtn.classList.add("expanded");
    } else {
        toggleSubtasksBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-6">
                <path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 0 1-1.06 0l-7.5-7.5a.75.75 0 0 1 1.06-1.06L12 14.69l6.97-6.97a.75.75 0 1 1 1.06 1.06l-7.5 7.5Z" clip-rule="evenodd" />
            </svg>
        `; // Down arrow initially
        toggleSubtasksBtn.classList.remove("expanded");
    }

    toggleSubtasksBtn.title = "Toggle subtasks";
    toggleSubtasksBtn.addEventListener("click", () => {
        const isExpanded = subtasksContainer.style.display === "block";
        subtasksContainer.style.display = isExpanded ? "none" : "block";
        
        if (isExpanded) {
            expandedTaskIds.delete(task.id);
        } else {
            expandedTaskIds.add(task.id);
        }

        toggleSubtasksBtn.classList.toggle("expanded", !isExpanded);
        toggleSubtasksBtn.innerHTML = isExpanded ? `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-6">
                <path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 0 1-1.06 0l-7.5-7.5a.75.75 0 0 1 1.06-1.06L12 14.69l6.97-6.97a.75.75 0 1 1 1.06 1.06l-7.5 7.5Z" clip-rule="evenodd" />
            </svg>
        ` : `
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-6">
                <path fill-rule="evenodd" d="M11.47 7.72a.75.75 0 0 1 1.06 0l7.5 7.5a.75.75 0 1 1-1.06 1.06L12 9.31l-6.97 6.97a.75.75 0 0 1-1.06-1.06l7.5-7.5Z" clip-rule="evenodd" />
            </svg>
        `; // Up arrow when expanded
    });
    li.insertBefore(toggleSubtasksBtn, li.querySelector(".task-actions")); // Insert before task actions

    // Render existing subtasks
    if (task.subtasks && task.subtasks.length > 0) {
        task.subtasks.forEach(subtask => {
            const subtaskLi = createSubTaskElement(task.id, subtask);
            subtaskList.appendChild(subtaskLi);
        });
    }


    // Drag & drop handlers (existing, moved to end for clarity)
    li.addEventListener("dragstart", e => {
      li.classList.add("dragging");
      draggedItem = li; // Store the dragged item
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", null); // Required for Firefox
    });

    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      draggedItem = null; // Clear the dragged item reference
      // Remove 'dragover' from all elements in case it was left on one
      [...taskList.children].forEach(item => {
          item.classList.remove("dragover-top", "dragover-bottom");
          item.style.borderTop = "";
          item.style.borderBottom = "";
      });
      updateTaskPositionsInDB();
    });

    li.addEventListener("dragover", e => {
      e.preventDefault(); // Allow drop
      if (!draggedItem || draggedItem === li) return; // Don't do anything if no item is dragged or if dragging over itself

      // Clear all previous dragover indicators efficiently
      // We only clear if a new item is being hovered, not on every single pixel movement
      const currentDragoverTop = taskList.querySelector(".dragover-top");
      if (currentDragoverTop && currentDragoverTop !== li) {
          currentDragoverTop.classList.remove("dragover-top");
          currentDragoverTop.style.borderTop = "";
      }
      const currentDragoverBottom = taskList.querySelector(".dragover-bottom");
      if (currentDragoverBottom && currentDragoverBottom !== li) {
          currentDragoverBottom.classList.remove("dragover-bottom");
          currentDragoverBottom.style.borderBottom = "";
      }

      const rect = li.getBoundingClientRect();
      const offset = e.clientY - rect.top;

      // Determine if hovering over the top or bottom half to indicate insertion point
      if (offset < rect.height / 2) {
        li.classList.add("dragover-top"); // Add class for top insertion
        li.style.borderTop = "2px solid var(--highlight-color)"; // Keep for immediate visual
        li.style.borderBottom = ""; // Ensure bottom border is clear
      } else {
        li.classList.add("dragover-bottom"); // Add class for bottom insertion
        li.style.borderBottom = "2px solid var(--highlight-color)"; // Keep for immediate visual
        li.style.top = ""; // Ensure top border is clear
      }
    });

    li.addEventListener("dragleave", () => {
      // Only remove dragover if it's not the currently dragged item itself
      if (li !== draggedItem) {
          li.classList.remove("dragover-top", "dragover-bottom"); // Remove specific classes
          li.style.borderTop = "";
          li.style.bottom = "";
      }
    });

    li.addEventListener("drop", e => {
      e.preventDefault();
      if (!draggedItem || draggedItem === li) return;

      // Clear dragover styles from the dropped-on element
      li.classList.remove("dragover-top", "dragover-bottom");
      li.style.borderTop = "";
      li.style.bottom = "";

      const rect = li.getBoundingClientRect();
      const offset = e.clientY - rect.top;

      // Insert the dragged item before or after the target item
      if (offset < rect.height / 2) {
        taskList.insertBefore(draggedItem, li);
      } else {
        taskList.insertBefore(draggedItem, li.nextSibling);
      }
      // updateTaskPositionsInDB will be called in dragend,
      // which fires after drop.
    });
    
    return li;
  }

// NEW: Function to create a sub-task element
function createSubTaskElement(parentTaskId, subtask) {
    const li = document.createElement("li");
    li.classList.add("subtask-item");
    li.dataset.subtaskId = subtask.id;
    li.dataset.parentTaskId = parentTaskId;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = subtask.is_done || false;
    checkbox.addEventListener("change", async () => {
        await toggleSubTask(parentTaskId, subtask.id, checkbox.checked);
        // We only need to update the UI for this specific subtask
        const subtaskTextSpan = li.querySelector(".subtask-text");
        if (subtaskTextSpan) {
            if (checkbox.checked) {
                subtaskTextSpan.classList.add("finished");
            } else {
                subtaskTextSpan.classList.remove("finished");
            }
        }
        // Update the parent task's subtask progress display
        const parentTaskElement = document.querySelector(`li[data-task-id="${parentTaskId}"]`);
        if (parentTaskElement) {
            const parentTask = allTasks.find(t => t.id == parentTaskId);
            if (parentTask && parentTask.subtasks) {
                const completedSubtasks = parentTask.subtasks.filter(st => st.is_done).length;
                const subtaskProgressDisplay = parentTaskElement.querySelector(".subtask-progress-display");
                if (subtaskProgressDisplay) {
                    subtaskProgressDisplay.textContent = `✅ ${completedSubtasks}/${parentTask.subtasks.length}`;
                }
            }
        }
    });
    li.appendChild(checkbox);

    const span = document.createElement("span");
    span.classList.add("subtask-text");
    span.textContent = subtask.content;
    if (subtask.is_done) {
        span.classList.add("finished");
    }
    li.appendChild(span);

    const deleteBtn = document.createElement("button");
    deleteBtn.classList.add("delete-button", "subtask-delete-button");
    deleteBtn.innerHTML = `🗑️`;
    deleteBtn.addEventListener("click", async () => {
        showCustomConfirm("Are you sure you want to delete this sub-task?", async () => {
            await deleteSubTask(parentTaskId, subtask.id);
            await loadTasks(); // Reload to update UI
        });
    });
    li.appendChild(deleteBtn);

    return li;
}

// NEW: Function to add a sub-task to a main task
async function addSubTask(parentTaskId, content) {
    const parentTask = allTasks.find(task => task.id == parentTaskId);
    if (!parentTask) {
        console.error("Parent task not found for adding sub-task:", parentTaskId);
        return;
    }

    const newSubtask = {
        id: crypto.randomUUID(), // Use crypto.randomUUID() for unique IDs
        content: content,
        is_done: false,
    };

    // Ensure subtasks array exists
    if (!parentTask.subtasks) {
        parentTask.subtasks = [];
    }
    parentTask.subtasks.push(newSubtask);

    // Update the main task in DB/Local Storage
    await updateTask(parentTaskId, { subtasks: parentTask.subtasks });
}

// NEW: Function to toggle a sub-task's completion status
async function toggleSubTask(parentTaskId, subtaskId, isDone) {
    const parentTask = allTasks.find(task => task.id == parentTaskId);
    if (!parentTask || !parentTask.subtasks) {
        console.error("Parent task or subtasks not found for toggling sub-task:", parentTaskId);
        return;
    }

    const subtaskIndex = parentTask.subtasks.findIndex(st => st.id == subtaskId);
    if (subtaskIndex !== -1) {
        parentTask.subtasks[subtaskIndex].is_done = isDone;
        await updateTask(parentTaskId, { subtasks: parentTask.subtasks });
    }
}

// NEW: Function to delete a sub-task
async function deleteSubTask(parentTaskId, subtaskId) {
    const parentTask = allTasks.find(task => task.id == parentTaskId);
    if (!parentTask || !parentTask.subtasks) {
        console.error("Parent task or subtasks not found for deleting sub-task:", parentTaskId);
        return;
    }

    parentTask.subtasks = parentTask.subtasks.filter(st => st.id != subtaskId);
    await updateTask(parentTaskId, { subtasks: parentTask.subtasks });
}


// Global array to hold files selected for a new task
let newSelectedFiles = [];

async function addTaskFromInput() {
    const taskInput = document.getElementById("taskInput");
    const categorySelect = document.getElementById("categorySelect");
    const prioritySelect = document.getElementById("prioritySelect");
    const dueDateInput = document.getElementById("dueDate"); // Updated ID
    const dueTimeInput = document.getElementById("dueTime"); // Updated ID
    const newAttachmentsDisplay = document.getElementById("newAttachmentsDisplay"); // Get the display area

    const taskText = taskInput.value.trim();
    if (!taskText) {
        showCustomAlert("Please enter a task description.");
        return;
    }

    const category = categorySelect.value;
    const priority = prioritySelect.value;

    // Combine date and time into a single ISO string for due_date
    let dueDateTime = null;
    const datePart = dueDateInput.value;
    const timePart = dueTimeInput.value;

    if (datePart) {
        // Construct a string that Date() will interpret as LOCAL time
        const combinedLocalDateTimeString = `${datePart}T${timePart || '00:00'}:00`;
        const localDateObj = new Date(combinedLocalDateTimeString);

        if (!isNaN(localDateObj.getTime())) {
            // Convert this local Date object to its UTC ISO string for storage
            dueDateTime = localDateObj.toISOString();
        } else {
            console.error("addTaskFromInput - Invalid date/time parsed:", combinedLocalDateTimeString);
        }
    }

    // Handle attachments for new task using newSelectedFiles
    const attachments = [];
    for (const file of newSelectedFiles) {
        const attachmentInfo = await handleFileUpload(null, file); // Pass null for taskId initially, will be updated later
        if (attachmentInfo) {
            attachments.push(attachmentInfo);
        }
    }

    const newTask = await addTask(taskText, category, priority, dueDateTime, null, attachments); // Pass attachments

    if (!newTask) return;

    // If attachments were added and we are in Supabase mode, update the task with the real task ID
    if (currentUser && attachments.length > 0) {
        const updatedAttachments = attachments.map(att => ({ ...att, task_id: newTask.id }));
        await updateTask(newTask.id, { attachments: updatedAttachments });
    }


    taskInput.value = "";
    categorySelect.value = "Personal";
    prioritySelect.value = "Medium";
    dueDateInput.value = "";
    dueTimeInput.value = "";
    
    // Clear selected files and update display for new task form
    newSelectedFiles = []; 
    newAttachmentsDisplay.innerHTML = ''; 

    updateTaskCounter();
    await loadTasks(); // Reload tasks to ensure new task is rendered and sorted
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
            modal.querySelector('.confirm-button').click(); // Corrected to confirm-button
        } else if (e.key === 'Escape') {
            modal.querySelector('.cancel-button').click(); // Corrected to cancel-button
        }
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
            onConfirm(null);
        }
    });
}

// --- NEW: Task Edit Modal Logic ---
const editTaskModal = document.getElementById("editTaskModal");
const closeEditModalButton = document.getElementById("closeEditModal");
const saveEditButton = document.getElementById("saveEditButton");
const cancelEditButton = document.getElementById("cancelEditButton");

const editTaskId = document.getElementById("editTaskId");
const editTaskContent = document.getElementById("editTaskContent");
const editCategorySelect = document.getElementById("editCategorySelect");
const editPrioritySelect = document.getElementById("editPrioritySelect");
const editDueDate = document.getElementById("editDueDate");
const editDueTime = document.getElementById("editDueTime"); // New ID for due time in modal
const editNotificationOffset = document.getElementById("editNotificationOffset"); // New ID for notification offset in modal
const editAttachmentInput = document.getElementById("editAttachmentInput"); // NEW attachment input for edit modal
const currentAttachmentsDisplay = document.getElementById("currentAttachmentsDisplay"); // NEW attachments display container

let attachmentsToKeep = []; // Global to track attachments in edit modal

function showEditModal(task) {
    editTaskId.value = task.id;
    editTaskContent.value = task.content;
    
    // Ensure the category and priority options exist in the select boxes
    ensureOptionExists(editCategorySelect, task.category);
    ensureOptionExists(editPrioritySelect, task.priority);

    editCategorySelect.value = task.category || "Personal";
    editPrioritySelect.value = "Medium"; // Default to Medium if not set
    if (task.priority) {
        editPrioritySelect.value = task.priority;
    } else {
        // If the task has no priority, try to select 'Medium' or the first available option
        const mediumOption = Array.from(editPrioritySelect.options).find(opt => opt.value === "Medium");
        if (mediumOption) {
            editPrioritySelect.value = "Medium";
        } else if (editPrioritySelect.options.length > 0) {
            editPrioritySelect.value = editPrioritySelect.options[0].value;
        }
    }

    // Format due_date for input[type="date"] and due_time for input[type="time"]
 if (task.due_date) {
    const dueDateObj = new Date(task.due_date); // This correctly parses the UTC ISO string
    if (!isNaN(dueDateObj.getTime())) {
        // Correctly get local date components for the date input
        const year = dueDateObj.getFullYear();
        const month = String(dueDateObj.getMonth() + 1).padStart(2, '0'); // Month is 0-indexed, so add 1
        const day = String(dueDateObj.getDate()).padStart(2, '0');
        editDueDate.value = `${year}-${month}-${day}`; // Format as YYYY-MM-DD (local date)

        // Get local hours and minutes for the time input (this part was already correct)
        const localHours = String(dueDateObj.getHours()).padStart(2, '0');
        const localMinutes = String(dueDateObj.getMinutes()).padStart(2, '0');
        editDueTime.value = `${localHours}:${localMinutes}`; // Format as HH:MM
    } else {
        editDueDate.value = '';
        editDueTime.value = '';
    }
} else {
    editDueDate.value = '';
    editDueTime.value = '';
}

    // Set notification offset
    editNotificationOffset.value = task.notification_time !== null ? task.notification_time : '';

    // Handle attachments in edit modal
    attachmentsToKeep = [...(task.attachments || [])]; // Initialize with existing attachments
    renderAttachments(attachmentsToKeep, currentAttachmentsDisplay, task.id, true); // Render existing, allow removal

    editTaskModal.style.display = "flex"; // Use flex to center
}

function ensureOptionExists(selectElement, value) {
    if (value && value !== "__custom__") {
        const exists = Array.from(selectElement.options).some(opt => opt.value === value);
        if (!exists) {
            const newOption = document.createElement("option");
            newOption.value = value;
            newOption.textContent = value;
            // Insert before the "__custom__" option
            selectElement.insertBefore(newOption, selectElement.lastElementChild);
        }
    }
}


function hideEditModal() {
    editTaskModal.style.display = "none";
    editAttachmentInput.value = ""; // Clear file input when modal closes
    currentAttachmentsDisplay.innerHTML = ""; // Clear displayed attachments
    attachmentsToKeep = []; // Reset attachments to keep
}

async function saveEditedTask() {
    const taskId = editTaskId.value;
    const content = editTaskContent.value.trim();
    const category = editCategorySelect.value;
    const priority = editPrioritySelect.value;
    const dueDate = editDueDate.value; // YYYY-MM-DD string
    const dueTime = editDueTime.value; // HH:MM string
    const notificationOffset = editNotificationOffset.value ? parseInt(editNotificationOffset.value, 10) : null;

    if (!content) {
        showCustomAlert("Task content cannot be empty.");
        return;
    }

    let updatedDueDateTime = null;
    if (dueDate) {
        // Combine date and time to form the full due_date ISO string
        // Use the dueTime from the modal, default to 00:00 if not set
        const combinedLocalDateTimeString = `${dueDate}T${dueTime || '00:00'}:00`;
        const localDateObj = new Date(combinedLocalDateTimeString);

        if (!isNaN(localDateObj.getTime())) {
            updatedDueDateTime = localDateObj.toISOString(); // Convert local Date object to UTC ISO string for storage
        } else {
            console.error("saveEditedTask - Invalid date/time parsed:", combinedLocalDateTimeString);
        }
    }

    // Process new attachments from the edit modal's file input
    const newAttachments = [];
    if (editAttachmentInput.files.length > 0) {
        for (const file of editAttachmentInput.files) {
            // Pass the taskId to handleFileUpload for Supabase Storage path
            const attachmentInfo = await handleFileUpload(taskId, file); 
            if (attachmentInfo) {
                newAttachments.push(attachmentInfo);
            }
        }
    }

    // Combine attachments to keep with newly uploaded ones
    const finalAttachments = [...attachmentsToKeep, ...newAttachments];

    let updates = {
        content: content,
        category: category,
        priority: priority,
        due_date: updatedDueDateTime, // This will be null if no date is set
        notification_time: notificationOffset, // This will be null if no offset is set
        attachments: finalAttachments, // Update with the combined attachments
    };

    try {
        await updateTask(taskId, updates); // Use the existing updateTask function
        await loadTasks(); // Reload tasks to reflect changes
        hideEditModal();
        showCustomAlert("Task updated successfully!");
    } catch (error) {
        console.error("Error saving edited task:", error);
        showCustomAlert("Failed to save task changes.");
    }
}

/**
 * Handles file upload to Supabase Storage or stores as base64 for guest mode.
 * @param {string} taskId The ID of the task this attachment belongs to.
 * @param {File} file The file object to upload.
 * @returns {Promise<Object|null>} A promise that resolves to an object { name, url, type, file_path (for supabase) } or null on error.
 */
async function handleFileUpload(taskId, file) {
    if (currentUser) {
        // --- Supabase Storage Upload Implementation ---
        // You MUST configure your Supabase Storage bucket (e.g., 'task-attachments')
        // and set up appropriate Row Level Security (RLS) policies for it.
        // Example RLS:
        // CREATE POLICY "Allow users to upload files" ON storage.objects FOR INSERT WITH CHECK (auth.uid() = (storage.foldername(bucket_id))[1]::uuid);
        // CREATE POLICY "Allow users to view their own attachments" ON storage.objects FOR SELECT USING (auth.uid() = (storage.foldername(bucket_id))[1]::uuid);
        // CREATE POLICY "Allow users to delete their own attachments" ON storage.objects FOR DELETE USING (auth.uid() = (storage.foldername(bucket_id))[1]::uuid);

        // Define the path in your storage bucket: user_id/task_id/file_name
        const filePath = `${currentUser.id}/${taskId || 'temp'}/${Date.now()}-${file.name}`; // Use 'temp' if taskId is not yet available (for new tasks)

        try {
            const { data: uploadData, error: uploadError } = await supabase.storage
                .from('task-attachments') // Replace with your actual bucket name
                .upload(filePath, file, {
                    cacheControl: '3600',
                    upsert: false // Set to true if you want to overwrite existing files with the same path
                });

            if (uploadError) {
                console.error("Supabase file upload failed:", uploadError.message);
                showCustomAlert("File upload failed: " + uploadError.message);
                return null;
            }

            // Get the public URL for the uploaded file
            const { data: publicUrlData } = supabase.storage
                .from('task-attachments') // Replace with your actual bucket name
                .getPublicUrl(uploadData.path);

            return { 
                name: file.name, 
                url: publicUrlData.publicUrl, 
                type: file.type,
                file_path: uploadData.path // Store the path for deletion later
            };

        } catch (e) {
            console.error("Error during Supabase file upload process:", e);
            showCustomAlert("An error occurred during file upload.");
            return null;
        }

    } else {
        // Guest mode: Store as Base64 (WARNING: Not suitable for large files! Not persistent across sessions/browsers)
        console.warn("Guest mode: Files are stored as Base64 data URLs in local storage. They are not uploaded to a server and will be lost if local storage is cleared.");
        showCustomAlert("Attachments in Guest Mode are stored locally and are not persistent. Log in for full attachment functionality.");
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                resolve({
                    name: file.name,
                    url: e.target.result, // Base64 data URL
                    type: file.type,
                    file_path: null // No file path for guest mode Base64
                });
            };
            reader.onerror = (e) => {
                console.error("Error reading file for guest mode:", e);
                showCustomAlert("Error reading file for guest mode.");
                resolve(null);
            };
            reader.readAsDataURL(file);
        });
    }
}

/**
 * Renders attachment links in a given container.
 * @param {Array<Object>} attachments Array of attachment objects { name, url, type, file_path }.
 * @param {HTMLElement} container The DOM element to render attachments into.
 * @param {string} taskId The ID of the parent task.
 * @param {boolean} editable If true, includes a remove button for each attachment.
 */
function renderAttachments(attachments, container, taskId, editable) {
    container.innerHTML = ''; // Clear previous attachments
    attachments.forEach(attachment => {
        const attachmentItem = document.createElement('span');
        attachmentItem.classList.add('attachment-item');

        const link = document.createElement('a');
        link.href = attachment.url;
        link.textContent = attachment.name;
        link.target = "_blank"; // Open in new tab
        link.rel = "noopener noreferrer"; // Security best practice
        attachmentItem.appendChild(link);

        if (editable) {
            const removeBtn = document.createElement('button');
            removeBtn.classList.add('remove-attachment-btn');
            removeBtn.textContent = 'x';
            removeBtn.title = `Remove ${attachment.name}`;
            removeBtn.addEventListener('click', () => {
                removeAttachment(taskId, attachment.url, attachment.file_path); // Pass file_path for Supabase deletion
            });
            attachmentItem.appendChild(removeBtn);
        }
        container.appendChild(attachmentItem);
    });
}

/**
 * Removes an attachment from a task.
 * @param {string} taskId The ID of the task.
 * @param {string} attachmentUrl The URL of the attachment to remove (used for guest mode).
 * @param {string} filePath The file path in Supabase Storage (used for logged-in users).
 */
async function removeAttachment(taskId, attachmentUrl, filePath) {
    showCustomConfirm("Are you sure you want to remove this attachment?", async () => {
        const task = allTasks.find(t => t.id == taskId);
        if (!task) {
            console.error("Task not found for attachment removal.");
            return;
        }

        let updatedAttachments = [];

        if (currentUser && filePath) {
            // Logged-in user: Attempt to delete from Supabase Storage
            try {
                const { error: storageError } = await supabase.storage
                    .from('task-attachments') // Replace with your actual bucket name
                    .remove([filePath]);

                if (storageError) {
                    console.error("Error deleting file from Supabase Storage:", storageError.message);
                    showCustomAlert("Failed to delete file from storage: " + storageError.message);
                    // Even if storage deletion fails, we might still remove from DB to avoid broken links
                }
            } catch (e) {
                console.error("Error during Supabase Storage deletion process:", e);
                showCustomAlert("An error occurred during file deletion from storage.");
            }
            // Filter out the attachment based on file_path (more robust for Supabase)
            updatedAttachments = task.attachments.filter(att => att.file_path !== filePath);
        } else {
            // Guest mode: Filter out the attachment based on URL
            updatedAttachments = task.attachments.filter(att => att.url !== attachmentUrl);
        }

        await updateTask(taskId, { attachments: updatedAttachments });
        // Update the `attachmentsToKeep` array in the modal if it's open
        attachmentsToKeep = updatedAttachments;
        renderAttachments(attachmentsToKeep, currentAttachmentsDisplay, taskId, true); // Re-render attachments in modal
        await loadTasks(); // Reload main task list to reflect changes
        showCustomAlert("Attachment removed.");
    });
}


// --- Filter and Sort Functionality ---
const categoryFilter = document.getElementById("categoryFilter");
const priorityFilter = document.getElementById("priorityFilter");
const sortOrder = document.getElementById("sortOrder");
const showCompleted = document.getElementById("showCompleted");
const clearFiltersButton = document.getElementById("clearFiltersButton");


function populateCategoryFilter(tasks) {
    const categories = new Set(tasks.map(task => task.category).filter(Boolean)); // Get unique categories
    categoryFilter.innerHTML = '<option value="all">All Categories</option>'; // Reset
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat;
        option.textContent = cat;
        categoryFilter.appendChild(option);
    });
    // Restore previous selection if it still exists
    const currentCategory = categoryFilter.dataset.currentValue || 'all';
    if (Array.from(categoryFilter.options).some(opt => opt.value === currentCategory)) {
        categoryFilter.value = currentCategory;
    } else {
        categoryFilter.value = 'all';
    }
}

function populatePriorityFilter(tasks) {
    const priorities = new Set(tasks.map(task => task.priority).filter(Boolean)); // Get unique priorities
    priorityFilter.innerHTML = '<option value="all">All Priorities</option>'; // Reset
    // Add default options if they're not in tasks
    const defaultPriorities = ["Scheduled", "Urgent", "High", "Medium", "Low"];
    defaultPriorities.forEach(p => {
        if (!priorities.has(p)) {
            priorities.add(p);
        }
    });

    // Sort priorities based on a predefined order
    const sortedPriorities = Array.from(priorities).sort((a, b) => {
        const order = { "Urgent": 1, "High": 2, "Medium": 3, "Low": 4, "Scheduled": 5 };
        return (order[a] || 99) - (order[b] || 99);
    });

    sortedPriorities.forEach(p => {
        const option = document.createElement('option');
        option.value = p;
        option.textContent = p;
        priorityFilter.appendChild(option);
    });
    // Restore previous selection if it still exists
    const currentPriority = priorityFilter.dataset.currentValue || 'all';
    if (Array.from(priorityFilter.options).some(opt => opt.value === currentPriority)) {
        priorityFilter.value = currentPriority;
    } else {
        priorityFilter.value = 'all';
    }
}

function filterTasks() {
    const searchTerm = document.getElementById("searchInput").value.toLowerCase().trim();
    const selectedCategory = categoryFilter.value;
    const selectedPriority = priorityFilter.value;
    const currentSortOrder = sortOrder.value;
    const shouldShowCompleted = showCompleted.checked;

    // Store current filter values to reapply after re-rendering
    categoryFilter.dataset.currentValue = selectedCategory;
    priorityFilter.dataset.currentValue = selectedPriority;
    sortOrder.dataset.currentValue = currentSortOrder;
    showCompleted.dataset.currentValue = shouldShowCompleted;

    let filteredAndSortedTasks = allTasks.filter(task => {
        const contentMatch = task.content.toLowerCase().includes(searchTerm);
        const categoryMatch = selectedCategory === "all" || task.category === selectedCategory;
        const priorityMatch = selectedPriority === "all" || task.priority === selectedPriority;
        
        // Check subtasks for search term
        const subtaskMatch = task.subtasks && task.subtasks.some(subtask => 
            subtask.content.toLowerCase().includes(searchTerm)
        );
        // Check attachments for search term (by name)
        const attachmentMatch = task.attachments && task.attachments.some(attachment =>
            attachment.name.toLowerCase().includes(searchTerm)
        );

        // Filter by completion status
        const completionMatch = shouldShowCompleted || !task.is_done;

        return (contentMatch || subtaskMatch || attachmentMatch) && categoryMatch && priorityMatch && completionMatch;
    });

    // Apply sorting
    filteredAndSortedTasks.sort((a, b) => {
        if (currentSortOrder === "dueDateAsc") {
            const dateA = a.due_date ? new Date(a.due_date).getTime() : Infinity;
            const dateB = b.due_date ? new Date(b.due_date).getTime() : Infinity;
            return dateA - dateB;
        } else if (currentSortOrder === "dueDateDesc") {
            const dateA = a.due_date ? new Date(a.due_date).getTime() : -Infinity;
            const dateB = b.due_date ? new Date(b.due_date).getTime() : -Infinity;
            return dateB - dateA;
        } else if (currentSortOrder === "priorityHighToLow") {
            const priorityOrder = { "Urgent": 1, "High": 2, "Medium": 3, "Low": 4, "Scheduled": 5 };
            return (priorityOrder[a.priority] || 99) - (priorityOrder[b.priority] || 99);
        } else if (currentSortOrder === "priorityLowToHigh") {
            const priorityOrder = { "Urgent": 1, "High": 2, "Medium": 3, "Low": 4, "Scheduled": 5 };
            return (priorityOrder[b.priority] || 99) - (priorityOrder[a.priority] || 99);
        } else if (currentSortOrder === "creationDateDesc") {
            const dateA = new Date(a.created_at).getTime();
            const dateB = new Date(b.created_at).getTime();
            return dateB - dateA;
        } else if (currentSortOrder === "alphabeticalAsc") {
            return a.content.localeCompare(b.content);
        } else if (currentSortOrder === "alphabeticalDesc") {
            return b.content.localeCompare(a.content);
        }
        return 0; // No change in order if no specific sort applied
    });

    renderTasks(filteredAndSortedTasks);
    updateTaskCounter();
}

// Debounce function
function debounce(func, delay) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

function clearAllFilters() {
    document.getElementById("searchInput").value = "";
    categoryFilter.value = "all";
    priorityFilter.value = "all";
    sortOrder.value = "creationDateDesc"; // Default sort order
    showCompleted.checked = false;
    filterTasks();
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
  const newAttachmentInput = document.getElementById("newAttachmentInput");
  const triggerNewAttachmentInput = document.getElementById("triggerNewAttachmentInput");
  const newAttachmentsDisplay = document.getElementById("newAttachmentsDisplay");


  if (addTaskButton) addTaskButton.addEventListener("click", addTaskFromInput);
  if (taskInput) taskInput.addEventListener("keypress", e => {
    if (e.key === "Enter") addTaskFromInput();
  });

  // NEW: Event listener for the "Add Attachment" button
  if (triggerNewAttachmentInput) {
      triggerNewAttachmentInput.addEventListener("click", () => {
          newAttachmentInput.click(); // Programmatically click the hidden file input
      });
  }

  // NEW: Event listener for the hidden file input to display selected files
  if (newAttachmentInput) {
      newAttachmentInput.addEventListener("change", () => {
          // Clear previous files if not multi-select, or add to existing
          newSelectedFiles = Array.from(newAttachmentInput.files); 
          newAttachmentsDisplay.innerHTML = ''; // Clear previous display
          if (newSelectedFiles.length > 0) {
              newSelectedFiles.forEach(file => {
                  const fileItem = document.createElement('span');
                  fileItem.classList.add('attachment-item');
                  fileItem.textContent = file.name;
                  newAttachmentsDisplay.appendChild(fileItem);
              });
          }
      });
  }


  // --- Sidebar Notes Toggle ---
  const toggleNotesBtn = document.getElementById("toggleNotes");
  const notesSidebar = document.getElementById("notesSidebar");
  const closeNotesBtn = document.getElementById("closeNotes");
  const notesInput = document.getElementById('notes');

  toggleNotesBtn?.addEventListener("click", () => {
    notesSidebar?.classList.add("open");
    if (toggleNotesBtn) toggleNotesBtn.style.display = "active";
    document.body.classList.add("notes-open");
    loadNote(); // No need to render markdown on toggle, only on input
  });

  closeNotesBtn?.addEventListener("click", () => {
    notesSidebar?.classList.remove("open");
    if (toggleNotesBtn) toggleNotesBtn.style.display = "block";
    document.body.classList.remove("notes-open");
    if (notesInput) saveNote(notesInput.value);
  });

  // Removed renderNotesMarkdown function as it was for a preview div not currently in HTML
  // function renderNotesMarkdown() {
  //   if (notesInput && notesOutput) {
  //     const markdown = notesInput.value;
  //     const html = marked.parse(markdown);
  //     notesOutput.innerHTML = html;
  //   }
  // }
  // notesInput?.addEventListener('input', renderNotesMarkdown); // No longer needed if no output div
  notesInput?.addEventListener('blur', () => {
      if (notesInput) saveNote(notesInput.value);
  });


  // --- Reset / Clear Buttons ---
  const taskList = document.getElementById("taskList");

  document.getElementById('resetCountBtn')?.addEventListener('click', async () => {
    showCustomConfirm("Are you sure you want to delete all tasks? This cannot be undone.", async () => {
        if (currentUser) {
            const { error } = await supabase.from('tasks').delete().eq('user_id', currentUser.id);
            if (error) console.error("Error resetting all tasks for user:", error.message);
            else {
                // Instead of rendering empty, reload tasks to ensure global state is reset
                await loadTasks(); 
                showCustomAlert("All tasks reset for your account.");
                clearAllScheduledNotifications();
            }
        } else {
            saveGuestTasks([]);
            // Instead of rendering empty, reload tasks to ensure global state is reset
            await loadTasks(); 
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
      // Do not remove li directly, loadTasks will re-render
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
    await loadTasks(); // Reload tasks to reflect deletion and update search/filter
  });

  // --- Category and Priority Custom Options for ADDING tasks ---
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

  // --- Event Listeners for Edit Modal ---
  if (closeEditModalButton) {
    closeEditModalButton.addEventListener("click", hideEditModal);
  }
  if (cancelEditButton) {
    cancelEditButton.addEventListener("click", hideEditModal);
  }
  if (saveEditButton) {
    saveEditButton.addEventListener("click", saveEditedTask);
  }

  // Close modal if user clicks outside
  window.addEventListener("click", (event) => {
    if (event.target === editTaskModal) {
      hideEditModal();
    }
  });

  // Add listeners for custom categories/priorities in the EDIT modal as well
  editCategorySelect?.addEventListener("change", () => {
    if (editCategorySelect.value === "__custom__") {
      showCustomPrompt("Enter new category:", (newCategory) => {
          if (newCategory && newCategory.trim()) {
            const trimmedCategory = newCategory.trim();
            const exists = Array.from(editCategorySelect.options).some(
              opt => opt.value.toLowerCase() === trimmedCategory.toLowerCase()
            );
            if (!exists) {
              const newOption = document.createElement("option");
              newOption.value = trimmedCategory;
              newOption.textContent = trimmedCategory;
              editCategorySelect.insertBefore(newOption, editCategorySelect.lastElementChild);
              editCategorySelect.value = trimmedCategory;
            } else {
              showCustomAlert("That category already exists.");
              editCategorySelect.value = "Personal";
            }
          } else {
            editCategorySelect.value = "Personal";
          }
      }, "Personal");
    }
  });

  editPrioritySelect?.addEventListener("change", () => {
    if (editPrioritySelect.value === "__custom__") {
      showCustomPrompt("Enter new priority:", (newPriority) => {
          if (newPriority && newPriority.trim()) {
            const trimmedPriority = newPriority.trim();
            const exists = Array.from(editPrioritySelect.options).some(
              opt => opt.value.toLowerCase() === trimmedPriority.toLowerCase()
            );
            if (!exists) {
              const newOption = document.createElement("option");
              newOption.value = trimmedPriority;
              newOption.textContent = trimmedPriority;
              editPrioritySelect.insertBefore(newOption, editPrioritySelect.lastElementChild);
              editPrioritySelect.value = trimmedPriority;
            } else {
              showCustomAlert("That priority already exists.");
              editPrioritySelect.value = "Medium";
            }
          } else {
            editPrioritySelect.value = "Medium";
          }
      }, "Medium");
    }
  });

  // --- Search Input Event Listener ---
  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
      searchInput.addEventListener("input", debounce(filterTasks, 300)); // Debounced search
  }

  // --- Filter and Sort Event Listeners ---
  if (categoryFilter) {
      categoryFilter.addEventListener("change", filterTasks);
  }
  if (priorityFilter) {
      priorityFilter.addEventListener("change", filterTasks);
  }
  if (sortOrder) {
      sortOrder.addEventListener("change", filterTasks);
  }
  if (showCompleted) {
      showCompleted.addEventListener("change", filterTasks);
  }
  if (clearFiltersButton) {
      clearFiltersButton.addEventListener("click", clearAllFilters);
  }

} // End of init()

// Init on DOM ready
window.addEventListener("DOMContentLoaded", init);
