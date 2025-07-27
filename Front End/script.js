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
                due_date: dueDateTime, // Store as full ISO string
                position: lastTaskPosition,
                notification_time: notificationTime, // This is expected to be minutes offset
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
            created_at: new Date().toISOString(),
            due_date: dueDateTime, // Store as full ISO string
            position: lastTaskPosition,
            notification_time: notificationTime, // This is expected to be minutes offset
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
// Inside script.js

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
            const notificationMessage = `${task.content} at ${formattedDueTime} in category ${task.category}`;

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


function createTaskElement(task) {
    const li = document.createElement("li");
    li.draggable = true;

    li.dataset.category = task.category || "";
    li.dataset.taskId = task.id;
    li.dataset.priority = task.priority || "Medium";
    li.dataset.position = task.position || 0;

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

      if (isChecked) {
        li.classList.add("finished");
        // Re-sort to move finished tasks to the bottom
        const finishedTasks = [...taskList.children].filter(item => item.classList.contains("finished"));
        const lastFinished = finishedTasks[finishedTasks.length - 1];
        if (lastFinished) {
          taskList.insertBefore(li, lastFinished.nextSibling);
        } else {
          taskList.appendChild(li); // Should go to end if no other finished tasks
        }
        clearScheduledNotification(task.id);
      } else {
        li.classList.remove("finished");
        // Re-sort to move unfinished tasks to the top, maintaining order
        const firstUnfinished = [...taskList.children].find(item => !item.classList.contains("finished"));
        if (firstUnfinished) {
          taskList.insertBefore(li, firstUnfinished);
        } else {
          taskList.prepend(li); // Should go to beginning if no other unfinished tasks
        }
        scheduleTaskNotification(task);
      }

      if (taskId) {
        // IMPORTANT: Update the task in Supabase or Local Storage
        await updateTask(taskId, { is_done: isChecked });
      }
      await updateTaskPositionsInDB(); // Update positions after re-ordering
      updateTaskCounter();
    });
    li.appendChild(checkbox);

    // Task Content
    const span = document.createElement("span");
    span.classList.add("task-text");
    span.innerHTML = marked.parse(task.content || "");
    span.setAttribute("data-raw", task.content || "");
    li.appendChild(span);
    
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
        notificationTimeDisplay.textContent = `🔔`;
    }
    li.appendChild(notificationTimeDisplay); // Appended after dueDateDisplay

    // Category label - MOVED HERE
    const categoryLabel = document.createElement("span");
    categoryLabel.classList.add("category-label");
    categoryLabel.textContent = `🏷️ ${task.category || "Personal"}`;
    categoryLabel.dataset.category = task.category || "";
    categoryLabel.style.cursor = "pointer";
    categoryLabel.title = `Filter by ${task.category || "Personal"}`;

    categoryLabel.addEventListener("click", (e) => {
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
    });
    li.appendChild(categoryLabel); // Appended after span

    // Priority label - MOVED HERE
    const priorityLabel = document.createElement("span");
    priorityLabel.classList.add("priority-label");
    priorityLabel.textContent = `⚡ ${task.priority || "Medium"}`;
    priorityLabel.style.cursor = "pointer";
    priorityLabel.title = `Filter by priority: ${task.priority || "Medium"}`;

    priorityLabel.addEventListener("click", (e) => {
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
          taskList.removeChild(li);
          updateTaskCounter();
      });
    });
    taskActions.appendChild(deleteBtn);

    // Append Task Actions
    li.appendChild(taskActions);


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

    return li;
  }

async function addTaskFromInput() {
    const taskInput = document.getElementById("taskInput");
    const categorySelect = document.getElementById("categorySelect");
    const prioritySelect = document.getElementById("prioritySelect");
    const dueDateInput = document.getElementById("dueDate"); // Updated ID
    const dueTimeInput = document.getElementById("dueTime"); // Updated ID
    const taskList = document.getElementById("taskList");

const newNotificationOffset = document.getElementById('newNotificationOffset');
// For the Edit Task Modal (you likely already have this, but confirm its ID)
const editNotificationOffset = document.getElementById('editNotificationOffset');

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

    // `notificationTime` (offset in minutes) is not set directly from the add task form
    // If you need it, add a separate input for it in the add task section.
    const newTask = await addTask(taskText, category, priority, dueDateTime, null); // Passing null for notification offset

    if (!newTask) return;

    // No need to create element and append, loadTasks() will re-render everything
    // const li = createTaskElement(newTask);
    // taskList.appendChild(li);

    taskInput.value = "";
    categorySelect.value = "Personal";
    prioritySelect.value = "Medium";
    dueDateInput.value = "";
    dueTimeInput.value = "";
    // notificationTimeInput.value = "15"; // Removed as this input is now for dueTime
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


function showEditModal(task) {
    editTaskId.value = task.id;
    editTaskContent.value = task.content;
    
    // Ensure the category and priority options exist in the select boxes
    ensureOptionExists(editCategorySelect, task.category);
    ensureOptionExists(editPrioritySelect, task.priority);

    editCategorySelect.value = task.category || "Personal";
    editPrioritySelect.value = task.priority || "Medium";

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

    let updates = {
        content: content,
        category: category,
        priority: priority,
        due_date: updatedDueDateTime, // This will be null if no date is set
        notification_time: notificationOffset, // This will be null if no offset is set
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
                renderTasks([]);
                updateTaskCounter();
                showCustomAlert("All tasks reset for your account.");
                clearAllScheduledNotifications();
            }
        } else {
            saveGuestTasks([]);
            renderTasks([]);
            updateTaskCounter();
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

} // End of init()

// Init on DOM ready
window.addEventListener("DOMContentLoaded", init);
