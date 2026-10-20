using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;

namespace ArmaApi;

/// <summary>
/// Single ordered outbox for everything the extension sends to Arma.
///
/// Arma accepts up to 100 callback messages per frame and returns a negative
/// value while the buffer is full, so messages are retried by a dedicated
/// worker thread instead of being dropped or blocking the HTTP threads.
/// Bursts that arrive within one frame are coalesced into a single "BATCH"
/// callback so a mass reload cannot flood the game.
/// </summary>
internal static class MessageQueue {
    private const string BatchFunction = "BATCH";
    private const int MaxBatchSize = 200;
    private static readonly TimeSpan BatchWindow = TimeSpan.FromMilliseconds(16);

    private static readonly BlockingCollection<(string Function, string Data)> Queue = new();
    private static readonly BlockingCollection<(string Function, string Data)> Inbox = new();
    private static readonly Thread Worker;

    static MessageQueue() {
        Worker = new Thread(Process) { IsBackground = true, Name = "ArmaApi.MessageWorker" };
        Worker.Start();
    }

    public static void Enqueue(string function, string data) {
        if (string.IsNullOrEmpty(function)) return;
        Inbox.Add((function, data));
    }

    private static void Process() {
        while (true) {
            if (!Inbox.TryTake(out var first, Timeout.Infinite)) continue;

            var batch = new List<(string Function, string Data)> { first };
            DateTime deadline = DateTime.UtcNow + BatchWindow;

            while (batch.Count < MaxBatchSize) {
                int remaining = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (remaining <= 0 || !Inbox.TryTake(out var next, remaining)) break;
                batch.Add(next);
            }

            if (batch.Count == 1)
                Queue.Add(batch[0]);
            else
                Queue.Add((BatchFunction, BuildBatch(batch)));

            DeliverQueue();
        }
    }

    private static string BuildBatch(List<(string Function, string Data)> batch) {
        var parts = new string[batch.Count];
        for (int i = 0; i < batch.Count; i++)
            parts[i] = $"[\"{batch[i].Function}\",{batch[i].Data}]";
        return "[" + string.Join(",", parts) + "]";
    }

    private static void DeliverQueue() {
        while (Queue.TryTake(out var message)) {
            while (true) {
                int slots;

                unsafe {
                    if (ArmaHost.Callback == null) {
                        // No SQF listener yet - hold the message until one is registered.
                        Thread.Sleep(5);
                        continue;
                    }

                    try {
                        slots = ArmaHost.Callback(ExtensionHost.Name, message.Function, message.Data);
                    } catch (Exception ex) {
                        ArmaLog.Error($"Callback for '{message.Function}' threw: {ex.Message}");
                        break;
                    }
                }

                if (slots >= 0) break;

                Thread.Sleep(1);
            }
        }
    }
}
