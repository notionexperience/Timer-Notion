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
            // You might want to preserve created_at or other fields from guest task if available
            // For now, let Supabase set created_at on insert
        }));

        // Using insert with ignoreDuplicates to avoid issues if a user logs in multiple times
        // and some data was already migrated (requires unique constraint on user_id + task_id or similar)
        // For simplicity, we're just inserting. If you want to prevent exact duplicates,
        // you'd need to fetch existing tasks first and filter.
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
            { onConflict: 'user_id' } // Upsert based on user_id ensures only one note per user
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
    alert("Login failed: " + error.message);
  } else {
    console.log("Logged in:", data);
    await migrateGuestDataToSupabase(); // Migrate any existing guest data
    await checkUserAndLoadApp(); // Reload app state with user data
  }
}

async function signUpUser(email, password) {
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) {
    console.error("Signup failed:", error.message);
    alert("Signup failed: " + error.message);
  } else {
    alert("Signup successful – check your email to confirm");
    // If auto-login after signup is enabled in Supabase, checkUserAndLoadApp will handle it.
    // Otherwise, user needs to confirm email and then log in, at which point migration happens.
    await migrateGuestDataToSupabase(); // Migrate immediately if auto-login occurs
    await checkUserAndLoadApp();
  }
}

async function signOutUser() {
  await supabase.auth.signOut();
  currentUser = null; // Clear current user status
  location.reload(); // Reloads the page to go back to guest/auth section
}

async function resetPasswordForEmailUser(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + "/reset.html" // CORRECTED URL
  });

  if (error) {
    alert("Error sending password setup email: " + error.message);
  } else {
    alert("Check your inbox to set your password.");
  }
}


// --- CORE: Check User and Load App Logic ---
async function checkUserAndLoadApp() {
  const { data: { user } } = await supabase.auth.getUser();

  const authSection = document.getElementById("auth-section");
  const appSection = document.getElementById("app-section");
  const guestModeMessage = document.getElementById("guestModeMessage");
  const logoutBtn = document.getElementById("logoutBtn"); // Get logout button reference

  // If user is logged in via Supabase
  if (user) {
    currentUser = user;
    if (authSection) authSection.style.display = "none";
    if (appSection) appSection.style.display = "block";
    if (guestModeMessage) guestModeMessage.style.display = "none";
    // Place logout button where you want it to be visible for logged in users
    if (logoutBtn) logoutBtn.style.display = "block"; // Assuming you want it visible when logged in

    await loadTasks(); // This will use Supabase
    await loadNote();  // This will use Supabase
  } else {
    // No Supabase user logged in. Act as a guest.
    currentUser = null; // Ensure currentUser is null for guest mode
    if (authSection) authSection.style.display = "block"; // Always show login options for guests
    if (appSection) appSection.style.display = "block";  // Always show app content for guests

    // Hide logout button for guests
    if (logoutBtn) logoutBtn.style.display = "none";


    const hasGuestData = getGuestTasks().length > 0 || getGuestNote().length > 0;
    if (guestModeMessage) {
        guestModeMessage.style.display = hasGuestData ? "block" : "none"; // Show message only if guest data exists
    }


    await loadTasks(); // This will use localStorage
    await loadNote();  // This will use localStorage
  }
}

// --- Data Persistence Functions (Conditional Logic) ---
// These functions will now automatically use Supabase if currentUser is set,
// and localStorage if currentUser is null.

async function loadTasks() {
    const taskList = document.getElementById("taskList");
    if (!taskList) { console.error("Task list element not found!"); return; }

    let tasks = [];
    if (currentUser) {
        // Load from Supabase
        const { data: supabaseTasks, error } = await supabase
            .from("tasks")
            .select("*")
            .eq("user_id", currentUser.id)
            .order("created_at", { ascending: false });

        if (error) {
            console.error("Failed to load tasks from Supabase:", error.message);
            return;
        }
        tasks = supabaseTasks;
        console.log("Loaded tasks from Supabase:", tasks);
    } else {
        // Load from Local Storage (Guest Mode)
        tasks = getGuestTasks();
        console.log("Loaded tasks from Local Storage (Guest Mode):", tasks);
    }
    renderTasks(tasks);
    updateTaskCounter();
}

async function addTask(content, category = "Personal", priority = "Medium") {
    let newTask = null;
    if (currentUser) {
        // Add to Supabase
        const { data, error } = await supabase.from("tasks").insert([
            {
                user_id: currentUser.id,
                content: content,
                is_done: false,
                category: category,
                priority: priority,
                elapsed: 0,
            },
        ]).select(); // .select() returns the inserted data

        if (error) {
            console.error("Add task to Supabase failed:", error.message);
            return null;
        }
        newTask = data[0];
    } else {
        // Add to Local Storage (Guest Mode)
        const guestTasks = getGuestTasks();
        newTask = {
            id: Date.now(), // Simple unique ID for guest tasks (critical for guest delete/update)
            content: content,
            is_done: false,
            category: category,
            priority: priority,
            elapsed: 0,
            created_at: new Date().toISOString(), // Add timestamp for consistency
        };
        guestTasks.push(newTask);
        saveGuestTasks(guestTasks);
        console.log("Added task to Local Storage (Guest Mode):", newTask);
    }
    return newTask; // Return the created task (with ID) for UI rendering
}

async function deleteTask(id) {
    if (currentUser) {
        // Delete from Supabase
        const { error } = await supabase
            .from("tasks")
            .delete()
            .eq("id", id)
            .eq("user_id", currentUser.id); // Ensure only user's own tasks are deleted

        if (error) console.error("Failed to delete task from Supabase:", error.message);
    } else {
        // Delete from Local Storage (Guest Mode)
        let guestTasks = getGuestTasks();
        guestTasks = guestTasks.filter(task => task.id !== id);
        saveGuestTasks(guestTasks);
        console.log("Deleted task from Local Storage (Guest Mode):", id);
    }
}

async function saveNote(content) {
    if (currentUser) {
        // Save to Supabase
        const { error } = await supabase.from("notes").upsert([
            {
                user_id: currentUser.id,
                content: content,
                updated_at: new Date().toISOString(),
            },
        ], { onConflict: 'user_id' }); // Upsert by user_id ensures only one note per user

        if (error) console.error("Failed to save note to Supabase:", error.message);
    } else {
        // Save to Local Storage (Guest Mode)
        saveGuestNote(content);
        console.log("Saved note to Local Storage (Guest Mode).");
    }
}

async function loadNote() {
    const notesArea = document.getElementById("notes");
    if (!notesArea) { console.error("Notes area element not found!"); return; }

    let noteContent = '';
    if (currentUser) {
        // Load from Supabase
        const { data, error } = await supabase
            .from("notes")
            .select("content")
            .eq("user_id", currentUser.id)
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 means "No rows found"
            console.error("Failed to load note from Supabase:", error.message);
            return;
        }
        noteContent = data?.content || '';
        console.log("Loaded note from Supabase:", noteContent);
    } else {
        // Load from Local Storage (Guest Mode)
        noteContent = getGuestNote();
        console.log("Loaded note from Local Storage (Guest Mode):", noteContent);
    }
    notesArea.value = noteContent;
}


// --- Helper / UI Functions (largely unchanged, but ensure they call the conditional data functions) ---

function renderTasks(tasks) {
  const taskList = document.getElementById("taskList");
  if (!taskList) {
    console.error("Task list element not found!");
    return;
  }
  taskList.innerHTML = ""; // Clear existing tasks
  tasks.forEach(task => {
    const li = createTaskElement(task);
    taskList.appendChild(li);
  });
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


// Timer variables and functions (from your original code)
let time = 0;
let timerInterval;
const timerElement = document.getElementById("timer");
const timeInput = document.getElementById("timeInput");
const setButton = document.getElementById("setButton");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");

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
    if(timerElement) timerElement.textContent = "Time's up!";
    if (startButton) startButton.disabled = false;
    if (stopButton) stopButton.disabled = true;
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
                const taskIndex = guestTasks.findIndex(t => t.id == taskId);
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
            const taskIndex = guestTasks.findIndex(t => t.id == taskId);
            if (taskIndex !== -1) {
                guestTasks[taskIndex].elapsed = finalElapsed;
                saveGuestTasks(guestTasks);
            }
        }
    }
}


function createTaskElement(task) {
    const li = document.createElement("li");
    li.draggable = true;

    li.dataset.category = task.category || "";
    li.dataset.elapsed = task.elapsed || 0;
    li.dataset.taskId = task.id; // CRITICAL: Use task.id from Supabase or generated for guest
    li.dataset.priority = task.priority || "Medium";

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
        stopTaskTimer(li); // Stop timer if task is finished
      } else {
        li.classList.remove("finished");
        const firstUnfinished = [...taskList.children].find(item => !item.classList.contains("finished"));
        if (firstUnfinished) {
          taskList.insertBefore(li, firstUnfinished);
        } else {
          taskList.prepend(li);
        }
      }

      // Update Supabase/LocalStorage task status
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
            const taskIndex = guestTasks.findIndex(t => t.id == taskId);
            if (taskIndex !== -1) {
                guestTasks[taskIndex].is_done = checkbox.checked;
                saveGuestTasks(guestTasks);
            }
        }
      }
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
    editBtn.innerHTML = "✏️";
    editBtn.classList.add("edit-button");
    editBtn.style.cursor = "pointer";
    editBtn.title = "Edit task";

    editBtn.addEventListener("click", async () => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = span.getAttribute("data-raw");
      input.className = "task-edit-input";

      categoryLabel.style.display = "none";
      priorityLabel.style.display = "none";
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
          // Update Supabase/LocalStorage
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
      const confirmDelete = confirm("Are you sure you want to delete this task?");
      if (!confirmDelete) return;

      const taskId = li.dataset.taskId;
      if (activeTaskId && activeTaskId.dataset.taskId === taskId) {
        stopTaskTimer(li);
      }

      await deleteTask(taskId); // Call the conditional deleteTask

      taskList.removeChild(li);
      updateTaskCounter();
    });


    // Drag & drop handlers (These seem mostly correct but review for subtle issues)
    li.addEventListener("dragstart", e => {
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", null);
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      [...taskList.children].forEach(item => item.classList.remove("dragover"));
    });
    li.addEventListener("dragover", e => {
      e.preventDefault();
      const dragging = taskList.querySelector(".dragging");
      if (li === dragging) return;

      [...taskList.children].forEach(item => item.classList.remove("dragover"));

      const rect = li.getBoundingClientRect();
      const offset = e.clientY - rect.top;

      if (offset < rect.height / 2) {
        li.classList.add("dragover");
        li.style.borderTop = "2px solid #007bff";
        li.style.borderBottom = "";
      } else {
        li.classList.add("dragover");
        li.style.borderBottom = "2px solid #007bff";
        li.style.borderTop = "";
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
    const taskList = document.getElementById("taskList"); // Get taskList inside this scope

    const taskText = taskInput.value.trim();
    if (!taskText) return;

    const category = categorySelect.value;
    const priority = prioritySelect.value;

    const newTask = await addTask(taskText, category, priority);
    if (!newTask) return;

    const li = createTaskElement(newTask);
    taskList.appendChild(li);

    taskInput.value = "";
    categorySelect.value = "Personal";
    prioritySelect.value = "Medium";
    updateTaskCounter();
}


// --- Main Init Function ---
function init() {
  console.log("App initialized ✅");

  // Initial check for user and load app content
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
      // saveNote(markdown); // No need to save on every input, only on blur/close
    }
  }
  notesInput?.addEventListener('input', renderNotesMarkdown);
  notesInput?.addEventListener('blur', () => { // Save on blur
      if (notesInput) saveNote(notesInput.value);
  });


  // --- Reset / Clear Buttons ---
  const taskList = document.getElementById("taskList"); // Ensure taskList is available in this scope

  document.getElementById('resetCountBtn')?.addEventListener('click', async () => {
    if (confirm("Are you sure you want to delete ALL tasks? This cannot be undone.")) {
        if (currentUser) {
            const { error } = await supabase.from('tasks').delete().eq('user_id', currentUser.id);
            if (error) console.error("Error resetting all tasks for user:", error.message);
            else {
                renderTasks([]); // Clear UI
                updateTaskCounter();
                alert("All tasks reset for your account.");
            }
        } else {
            saveGuestTasks([]); // Clear localStorage tasks
            renderTasks([]); // Clear UI
            updateTaskCounter();
            alert("All tasks reset for guest mode (on this device).");
        }
    }
  });

  document.getElementById('clearFinishedBtn')?.addEventListener('click', async () => {
    const finishedTasksElements = taskList.querySelectorAll('li.finished');
    const tasksToDeleteIds = [];

    finishedTasksElements.forEach(li => {
      const taskId = li.dataset.taskId;
      if (taskId) {
        tasksToDeleteIds.push(taskId);
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
        console.log("Finished tasks deleted from Local Storage.");
      }
    }
    updateTaskCounter();
  });

  // --- Category and Priority Custom Options ---
  const categorySelect = document.getElementById("categorySelect");
  const prioritySelect = document.getElementById("prioritySelect");

  categorySelect?.addEventListener("change", () => {
    if (categorySelect.value === "__custom__") {
      const newCategory = prompt("Enter new category name:");
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
          alert("That category already exists.");
          categorySelect.value = "Personal";
        }
      } else {
        categorySelect.value = "Personal";
      }
    }
  });

  prioritySelect?.addEventListener("change", () => {
    if (prioritySelect.value === "__custom__") {
      const newPriority = prompt("Enter new priority:");
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
          alert("That priority already exists.");
          prioritySelect.value = "Medium";
        }
      } else {
        prioritySelect.value = "Medium";
      }
    }
  });

} // End of init()

// Init on DOM ready
window.addEventListener("DOMContentLoaded", init);