import { supabase } from './supabase-init.js';

let currentUser = null; // Declare currentUser in a higher scope

async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("Login failed:", error.message);
  } else {
    console.log("Logged in:", data);
  }
}

async function checkUserAndLoadApp() {
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    currentUser = user;
    document.getElementById("auth-section").style.display = "none";
    document.getElementById("app-section").style.display = "block";
    await loadTasks(); // Await loadTasks to ensure they are loaded before other operations
    await loadNote(); // Load note as well
  } else {
    document.getElementById("auth-section").style.display = "block";
    document.getElementById("app-section").style.display = "none";
  }
}

async function saveNote(content) {
  if (!currentUser) {
    console.error("No user logged in to save note.");
    return;
  }
  const { error } = await supabase.from("notes").upsert([
    {
      user_id: currentUser.id,
      content: content,
      updated_at: new Date().toISOString(),
    },
  ]);

  if (error) console.error("Failed to save note:", error.message);
}

async function loadTasks() {
  // It's good to re-check user here, as this function can be called independently
  const { data: { user } } = await supabase.auth.getUser();
  currentUser = user; // Ensure currentUser is up-to-date

  if (!user) {
    console.warn("User not logged in, cannot load tasks.");
    return;
  }

  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to load tasks:", error.message);
    return;
  }

  console.log("Loaded tasks:", tasks);
  renderTasks(tasks);
  updateTaskCounter(); // Update counter after loading tasks
}

async function addTask(content, category = "Personal", priority = "Medium") { // Added defaults
  if (!currentUser) {
    console.error("No user logged in to add task.");
    return null;
  }
  const { data, error } = await supabase.from("tasks").insert([
    {
      user_id: currentUser.id,
      content: content,
      is_done: false,
      category: category,
      priority: priority,
      elapsed: 0,
    },
  ]).select();

  if (error) {
    console.error("Add task failed:", error.message);
    return null;
  }

  return data[0]; // return the inserted task object
}

async function deleteTask(id) {
  if (!currentUser) {
    console.error("No user logged in to delete task.");
    return;
  }
  const { error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id);

  if (error) console.error("Failed to delete task:", error.message);
}

async function loadNote() {
  if (!currentUser) {
    console.warn("No user logged in to load note.");
    return;
  }
  const { data, error } = await supabase
    .from("notes")
    .select("content")
    .eq("user_id", currentUser.id)
    .single();

  // PGRST116 means "No rows found", which is not an error for loading notes
  if (error && error.code !== 'PGRST116') {
    console.error("Failed to load note:", error.message);
    return;
  }

  const notesArea = document.getElementById("notes");
  if (notesArea && data?.content) { // Check if notesArea exists
    notesArea.value = data.content;
  }
}

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
  if (!taskList) return; // Prevent error if element not found
  const totalTasks = taskList.children.length;
  const finishedTasks = taskList.querySelectorAll("li.finished").length;

  const counterSpan = document.querySelector("#taskCountToday .count");

  if (counterSpan) {
    counterSpan.textContent = `${finishedTasks} / ${totalTasks}`;
  }
}

// ==== Main App Logic ====
function init() {
  console.log("App initialized ✅");
  checkUserAndLoadApp();

  // Your timer/task logic here...
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
    timerElement.textContent = `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;

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
      startButton.disabled = false;
      stopButton.disabled = true;
      clearInterval(timerInterval);
    }
  }

  function updateTimer() {
    if (time <= 0) {
      clearInterval(timerInterval);
      timerElement.textContent = "Time's up!";
      startButton.disabled = false;
      stopButton.disabled = true;
      return;
    }
    updateTimerDisplay();
    time--;
  }

  function startTimer() {
    startButton.disabled = true;
    stopButton.disabled = false;
    timerElement.classList.add("active");
    timerInterval = setInterval(updateTimer, 1000);
  }

  function stopTimer() {
    startButton.disabled = false;
    stopButton.disabled = true;
    timerElement.classList.remove("active");
    clearInterval(timerInterval);
  }

  if (setButton) setButton.addEventListener("click", setTimer);
  if (startButton) startButton.addEventListener("click", startTimer);
  if (stopButton) stopButton.addEventListener("click", stopTimer);

  updateTimerDisplay();

  // ==== TASKS ====
  const taskInput = document.getElementById("taskInput");
  const categorySelect = document.getElementById("categorySelect");
  const prioritySelect = document.getElementById("prioritySelect"); // Assuming this exists
  const addTaskButton = document.getElementById("addTaskButton");
  const taskList = document.getElementById("taskList");


  let activeTaskTimer = null;
  let activeTaskId = null;

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  function stopTaskTimerIfRunning(li) {
    if (activeTaskTimer && activeTaskId !== li) {
      clearInterval(activeTaskTimer);
      const activeLi = activeTaskId;
      if (activeLi) {
        const buttons = activeLi.querySelectorAll(".timer-button");
        buttons[0].disabled = false; // start
        buttons[1].disabled = true;  // stop
      }
      activeTaskTimer = null;
      activeTaskId = null;
    }
    if (activeTaskId === li) {
      stopTaskTimer(li);
    }
  }

  function startTaskTimer(li) {
    if (li.classList.contains("finished")) return; // don't time finished tasks
    if (activeTaskTimer) {
      stopTaskTimer(activeTaskId);
    }
    li.classList.add("active-task");

    const timerDisplay = li.querySelector(".task-timer");
    const startBtn = li.querySelector(".timer-button:not(.stop)");
    const stopBtn = li.querySelector(".timer-button.stop");

    startBtn.disabled = true;
    stopBtn.disabled = false;

    activeTaskId = li;

    activeTaskTimer = setInterval(async () => { // Make async to save elapsed time
      let elapsed = parseInt(li.dataset.elapsed, 10) || 0;
      elapsed++;
      li.dataset.elapsed = elapsed;
      timerDisplay.textContent = formatTime(elapsed);

      // Optionally, save elapsed time to Supabase periodically
      const taskId = li.dataset.taskId;
      if (taskId && elapsed % 5 === 0) { // Save every 5 seconds
        const { error } = await supabase
          .from("tasks")
          .update({ elapsed: elapsed })
          .eq("id", taskId)
          .eq("user_id", currentUser.id);
        if (error) console.error("Failed to update elapsed time:", error.message);
      }
    }, 1000);
  }

  function stopTaskTimer(li) {
    if (activeTaskId !== li) return;
    clearInterval(activeTaskTimer);
    activeTaskTimer = null;
    activeTaskId = null;

    li.classList.remove("active-task");

    const startBtn = li.querySelector(".timer-button:not(.stop)");
    const stopBtn = li.querySelector(".timer-button.stop");

    startBtn.disabled = false;
    stopBtn.disabled = true;

    // Save final elapsed time to Supabase on stop
    const taskId = li.dataset.taskId;
    const finalElapsed = parseInt(li.dataset.elapsed, 10) || 0;
    if (taskId) {
      supabase
        .from("tasks")
        .update({ elapsed: finalElapsed })
        .eq("id", taskId)
        .eq("user_id", currentUser.id)
        .then(({ error }) => {
          if (error) console.error("Failed to save final elapsed time:", error.message);
        });
    }
  }

  function createTaskElement(task) {
    const li = document.createElement("li");
    li.draggable = true;

    li.dataset.category = task.category || "";
    li.dataset.elapsed = task.elapsed || 0;
    li.dataset.taskId = task.id;
    li.dataset.priority = task.priority || "Medium"; // Ensure priority is set

    // Checkbox
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.is_done || false; // Use task.is_done

    checkbox.addEventListener("change", async () => {
      if (checkbox.checked) {
        li.classList.add("finished");
        // Move to bottom, but maintain order of finished tasks
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
        // Move back to unfinished section, maintaining order (e.g., at the top)
        const firstUnfinished = [...taskList.children].find(item => !item.classList.contains("finished"));
        if (firstUnfinished) {
          taskList.insertBefore(li, firstUnfinished);
        } else {
          taskList.prepend(li); // If all are finished, put at top
        }
      }

      // ✅ Update Supabase task status
      const taskId = li.dataset.taskId;
      if (taskId) {
        const { error } = await supabase
          .from("tasks")
          .update({ is_done: checkbox.checked })
          .eq("id", taskId)
          .eq("user_id", currentUser.id);

        if (error) console.error("Update error:", error.message);
      }

      updateTaskCounter();
    });

    if (checkbox.checked) {
      li.classList.add("finished");
    }

    // Task text span (marked.js usage)
    const span = document.createElement("span");
    span.classList.add("task-text");
    span.innerHTML = marked.parse(task.content || ""); // Use task.content
    span.setAttribute("data-raw", task.content || "");

    // Category label
    const categoryLabel = document.createElement("span");
    categoryLabel.classList.add("category-label");
    categoryLabel.textContent = `🏷️ ${task.category || "Personal"}`;
    categoryLabel.dataset.category = task.category || "";
    categoryLabel.style.cursor = "pointer";
    categoryLabel.title = `Filter by ${task.category || "Personal"}`;

    // === CATEGORY FILTER ON CLICK ===
    categoryLabel.addEventListener("click", async (e) => { // Made async for Supabase update
      if (e.ctrlKey || e.metaKey || e.button === 2) {
        // === Edit mode ===
        e.preventDefault();
        const select = document.createElement("select");
        ["Work", "Personal", "Health"].forEach(optionText => {
          const option = document.createElement("option");
          option.value = optionText;
          option.textContent = optionText;
          if (optionText === task.category) option.selected = true;
          select.appendChild(option);
        });

        async function saveCategory() { // Made async for Supabase update
          const newCategory = select.value;
          task.category = newCategory;
          categoryLabel.textContent = `🏷️ ${newCategory}`;
          categoryLabel.dataset.category = newCategory;
          li.dataset.category = newCategory;
          select.replaceWith(categoryLabel);

          // Update Supabase
          const { error } = await supabase
            .from("tasks")
            .update({ category: newCategory })
            .eq("id", task.id)
            .eq("user_id", currentUser.id);
          if (error) console.error("Failed to update category:", error.message);
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
        // === Filter mode ===
        const allTasks = document.querySelectorAll("#taskList li");
        const isActive = categoryLabel.classList.toggle("active-category");

        allTasks.forEach(taskEl => {
          const taskCat = taskEl.dataset.category;
          const shouldShow = isActive ? taskCat === task.category : true;
          taskEl.style.display = shouldShow ? "" : "none";
        });

        // Deactivate other labels
        document.querySelectorAll(".category-label").forEach(label => {
          if (label !== categoryLabel) label.classList.remove("active-category");
        });

        if (!isActive) {
          allTasks.forEach(taskEl => taskEl.style.display = "");
        }
      }
    });

    // === PRIORITY LABEL ===
    const priorityLabel = document.createElement("span");
    priorityLabel.classList.add("priority-label");
    priorityLabel.textContent = `⚡ ${task.priority || "Medium"}`;
    priorityLabel.style.cursor = "pointer";
    priorityLabel.title = `Filter by priority: ${task.priority || "Medium"}`;

    // === PRIORITY FILTER ON CLICK ===
    priorityLabel.addEventListener("click", async (e) => { // Made async for Supabase update
      if (e.ctrlKey || e.metaKey || e.button === 2) {
        // === CTRL+CLICK or RIGHT-CLICK: Edit priority ===
        e.preventDefault();

        const select = document.createElement("select");
        ["Low", "Medium", "High"].forEach(optionText => {
          const option = document.createElement("option");
          option.value = optionText;
          option.textContent = optionText;
          if (optionText === task.priority) option.selected = true;
          select.appendChild(option);
        });

        async function savePriority() { // Made async for Supabase update
          const newPriority = select.value;
          task.priority = newPriority;

          // Update the existing label directly instead of creating a new one
          priorityLabel.textContent = `⚡ ${newPriority}`;
          priorityLabel.title = `Filter by priority: ${newPriority}`;
          li.dataset.priority = newPriority;

          select.replaceWith(priorityLabel); // Replace the select with the updated label

          // Update Supabase
          const { error } = await supabase
            .from("tasks")
            .update({ priority: newPriority })
            .eq("id", task.id)
            .eq("user_id", currentUser.id);
          if (error) console.error("Failed to update priority:", error.message);
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
        // === NORMAL CLICK: Filter tasks by priority ===
        const allTasks = document.querySelectorAll("#taskList li");
        const isActive = priorityLabel.classList.toggle("active-priority");

        allTasks.forEach(taskEl => {
          const taskPriority = taskEl.dataset.priority; // Use dataset for filtering
          const shouldShow = isActive ? taskPriority === (task.priority || "Medium") : true;
          taskEl.style.display = shouldShow ? "" : "none";
        });

        // Reset other priority filters
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

    editBtn.addEventListener("click", async () => { // Make async for Supabase update
      const input = document.createElement("input");
      input.type = "text";
      input.value = span.getAttribute("data-raw"); // Use raw content for editing
      input.className = "task-edit-input";

      // Hide category, priority, timer display, start and stop buttons
      categoryLabel.style.display = "none";
      priorityLabel.style.display = "none";
      timerDisplay.style.display = "none";
      startTimerBtn.style.display = "none";
      stopTimerBtn.style.display = "none";

      span.replaceWith(input);
      input.focus();

      async function save() { // Make async for Supabase update
        const val = input.value.trim();
        if (val !== "") {
          span.innerHTML = marked.parse(val);       // Re-render Markdown
          span.setAttribute("data-raw", val);       // Store raw for re-editing
          span.className = "task-text";             // Reapply styling
          // Update Supabase
          const { error } = await supabase
            .from("tasks")
            .update({ content: val })
            .eq("id", task.id)
            .eq("user_id", currentUser.id);
          if (error) console.error("Failed to update task content:", error.message);
        }
        input.replaceWith(span);

        // Restore hidden elements
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
          // Show hidden elements again on cancel
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
      if (activeTaskId === li) {
        stopTaskTimer(li);
      }

      if (taskId) {
        const { error } = await supabase
          .from("tasks")
          .delete()
          .eq("id", taskId)
          .eq("user_id", currentUser.id);

        if (error) {
          console.error("Delete error:", error.message);
          return;
        }
      }

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
    const taskText = taskInput.value.trim();
    if (!taskText) return;

    const category = categorySelect.value;
    const priority = prioritySelect.value;

    const newTask = await addTask(taskText, category, priority); // Pass category and priority
    if (!newTask) return;

    const li = createTaskElement(newTask);
    taskList.appendChild(li);

    taskInput.value = "";
    categorySelect.value = "Personal"; // Reset to default
    prioritySelect.value = "Medium"; // Reset to default
    updateTaskCounter();
  }

  // Use this single event listener for adding tasks
  if (addTaskButton) addTaskButton.addEventListener("click", addTaskFromInput);
  if (taskInput) taskInput.addEventListener("keypress", e => {
    if (e.key === "Enter") addTaskFromInput();
  });

  // Additional UI stuff like notes sidebar, reset buttons etc. would go here as in your original code
  // Sidebar notes toggle logic
  
  document.getElementById("signUpBtn")?.addEventListener("click", async () => {
    const email = document.getElementById("emailInput").value;
    const password = document.getElementById("passwordInput").value;
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) return console.error("Signup failed:", error.message);
    alert("Signup successful – check your email to confirm");
  });

  document.getElementById("signInBtn")?.addEventListener("click", async () => {
    const email = document.getElementById("emailInput").value;
    const password = document.getElementById("passwordInput").value;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return console.error("Login failed:", error.message);
    console.log("Logged in:", data);
    await checkUserAndLoadApp(); // Re-check user and load app after successful sign-in
  });

  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    await supabase.auth.signOut();
    location.reload();
  });
document.getElementById("sendResetEmailBtn").addEventListener("click", async () => {
  const email = document.getElementById("emailInput").value;

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + "./reset.html"
  });

  if (error) {
    alert("Error sending password setup email: " + error.message);
  } else {
    alert("Check your inbox to set your password.");
  }
});

  const toggleNotesBtn = document.getElementById("toggleNotes");
  const notesSidebar = document.getElementById("notesSidebar");
  const closeNotesBtn = document.getElementById("closeNotes");

  toggleNotesBtn?.addEventListener("click", () => {
    notesSidebar?.classList.add("open");
    if (toggleNotesBtn) toggleNotesBtn.style.display = "none";
    document.body.classList.add("notes-open");
    loadNote(); // Load note when opening sidebar
  });

  closeNotesBtn?.addEventListener("click", () => {
    notesSidebar?.classList.remove("open");
    if (toggleNotesBtn) toggleNotesBtn.style.display = "block";
    document.body.classList.remove("notes-open");
    // Save note content when closing sidebar
    const notesArea = document.getElementById("notes");
    if (notesArea) saveNote(notesArea.value);
  });

  document.getElementById('resetCountBtn')?.addEventListener('click', () => {
    // 3. Reset counter
    const counter = document.querySelector('#taskCountToday .count');
    if (counter) {
      counter.textContent = '0';
    }
    // 4. Show Undo button for 10 seconds (you need to implement undo logic)
    const undoBtn = document.getElementById('undoResetBtn');
    if (undoBtn) undoBtn.style.display = 'inline-block';
    // You might want to save current state or clear tasks here based on what 'resetCountBtn' means
  });

  document.getElementById('clearFinishedBtn')?.addEventListener('click', async () => { // Make async for Supabase interaction
    const finishedTasksElements = taskList.querySelectorAll('li.finished');
    const tasksToDelete = [];

    finishedTasksElements.forEach(li => {
      const taskId = li.dataset.taskId;
      if (taskId) {
        tasksToDelete.push(taskId);
      }
      li.remove(); // Remove from DOM immediately
    });

    // Delete from Supabase
    if (tasksToDelete.length > 0) {
      const { error } = await supabase
        .from("tasks")
        .delete()
        .in("id", tasksToDelete)
        .eq("user_id", currentUser.id); // Ensure user_id is matched

      if (error) {
        console.error("Failed to delete finished tasks:", error.message);
      } else {
        console.log("Finished tasks deleted from Supabase.");
      }
    }

    updateTaskCounter(); // Update counter after removal

    // Show undo button for 10 seconds (requires more complex undo logic with Supabase)
    const undoBtn = document.getElementById('undoResetBtn');
    if (undoBtn) undoBtn.style.display = 'inline-block';
  });

  const input = document.getElementById('sidebar-notes-input');
  const output = document.getElementById('sidebar-notes-output');

  function renderMarkdown() {
    if (input && output) {
      const markdown = input.value;
      const html = marked.parse(markdown);
      output.innerHTML = html;
      saveNote(markdown); // Save note content as it's typed
    }
  }

  input?.addEventListener('input', renderMarkdown);

  // Load initial note content (this call needs to happen after init() to ensure notesArea is available)
  // Moved this to checkUserAndLoadApp for correct timing.

  // Theme toggle logic
  const themeToggle = document.getElementById("themeToggle");
  themeToggle?.addEventListener("click", () => {
    const isDark = document.body.getAttribute("data-theme") === "dark";
    document.body.setAttribute("data-theme", isDark ? "light" : "dark");
    localStorage.setItem("theme", isDark ? "light" : "dark");
  });

  // Load saved theme
  const savedTheme = localStorage.getItem("theme");
  if (savedTheme) {
    document.body.setAttribute("data-theme", savedTheme);
  }
}

// Event listeners for category and priority custom options
document.addEventListener("DOMContentLoaded", () => {
  const categorySelect = document.getElementById("categorySelect");
  const prioritySelect = document.getElementById("prioritySelect");

  categorySelect?.addEventListener("change", () => {
    if (categorySelect.value === "__custom__") {
      const newCategory = prompt("Enter new category name:");
      if (newCategory && newCategory.trim()) {
        const trimmedCategory = newCategory.trim();

        // Check if it already exists
        const exists = Array.from(categorySelect.options).some(
          option => option.value.toLowerCase() === trimmedCategory.toLowerCase()
        );

        if (!exists) {
          const newOption = document.createElement("option");
          newOption.value = trimmedCategory;
          newOption.textContent = trimmedCategory;

          // Insert before the "Add New" option
          categorySelect.insertBefore(newOption, categorySelect.lastElementChild);
          categorySelect.value = trimmedCategory;
        } else {
          alert("That category already exists.");
          categorySelect.value = "Personal"; // fallback to default
        }
      } else {
        categorySelect.value = "Personal"; // fallback if canceled or empty
      }
    }
  });

  prioritySelect?.addEventListener("change", () => {
    if (prioritySelect.value === "__custom__") {
      const newPriority = prompt("Enter new priority:");
      if (newPriority && newPriority.trim()) {
        const trimmedPriority = newPriority.trim();

        // Check if it already exists
        const exists = Array.from(prioritySelect.options).some(
          opt => opt.value.toLowerCase() === trimmedPriority.toLowerCase()
        );

        if (!exists) {
          const newOption = document.createElement("option");
          newOption.value = trimmedPriority;
          newOption.textContent = trimmedPriority;

          // Insert before "Add New Priority…" option
          prioritySelect.insertBefore(newOption, prioritySelect.lastElementChild);
          prioritySelect.value = trimmedPriority;
        } else {
          alert("That priority already exists.");
          prioritySelect.value = "Medium"; // fallback default
        }
      } else {
        prioritySelect.value = "Medium"; // fallback if canceled or empty
      }
    }
  });
});


// Init on DOM ready
window.addEventListener("DOMContentLoaded", init);
